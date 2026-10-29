// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title BatchExecutor
/// @notice Bounded, deployer-authorized CALL batches. A failed subcall does not
///         abort subsequent actions; all actions belong to ONE transaction.
/// @dev Targets see this contract as msg.sender, NOT the submitting wallet.
///      No delegatecall, owner changes, upgrades, arbitrary native balance
///      spending, or retries. The deployer is trusted to authorize target calls,
///      including token calls; strangers cannot use this as an approval proxy.
///      Successful low-level CALL != business success
///      (for example, an ERC20 may return false without reverting).
contract BatchExecutor {
    struct Action {
        bytes32 id;
        address target;
        uint256 value;
        uint256 gasLimit;
        bytes data;
    }

    struct Result {
        bool success;
        bytes data;
        uint256 returnDataSize;
    }

    uint256 public constant MIN_ACTIONS = 3;
    uint256 public constant MAX_ACTIONS = 32;
    uint256 public constant MIN_CALL_GAS = 25_000;
    uint256 public constant MAX_CALL_GAS = 1_000_000;
    uint256 public constant MAX_CALLDATA = 4_096;
    uint256 public constant MAX_RETURN_DATA = 2_048;

    // Conservative reserves cover CALL setup (including new-account value
    // transfers), capped result copying, events and refund accounting.
    uint256 public constant ACTION_RESERVE_GAS = 60_000;
    uint256 public constant FINISH_RESERVE_GAS = 60_000;

    mapping(address => uint256) public refundCredits;
    // Write-once storage keeps runtime bytecode identical across deployments.
    // No setter, delegatecall or upgrade path can change this caller.
    address public authorizedCaller;
    uint256 private locked = 1;

    error UnauthorizedCaller();
    error InvalidCount(uint256 count);
    error InvalidId(uint256 index);
    error DuplicateId(uint256 index);
    error InvalidTarget(uint256 index);
    error InvalidCalldata(uint256 index);
    error InvalidGasLimit(uint256 index);
    error ValueMismatch(uint256 supplied, uint256 required);
    error InsufficientBatchGas(uint256 available, uint256 required);
    error ReentrantCall();
    error InvalidRecipient();
    error NoRefund();
    error RefundTransferFailed();

    event ActionExecuted(
        uint256 indexed index,
        bytes32 indexed id,
        address indexed target,
        bool success,
        bytes result,
        uint256 returnDataSize
    );
    event BatchExecuted(address indexed sender, uint256 total, uint256 succeeded, uint256 failed);
    event RefundCredited(address indexed sender, uint256 amount);
    event RefundWithdrawn(address indexed sender, address indexed recipient, uint256 amount);

    constructor() {
        authorizedCaller = msg.sender;
    }

    modifier onlyAuthorizedCaller() {
        if (msg.sender != authorizedCaller) revert UnauthorizedCaller();
        _;
    }

    modifier nonReentrant() {
        if (locked != 1) revert ReentrantCall();
        locked = 2;
        _;
        locked = 1;
    }

    /// @notice Only the deployer executes 3..32 caller-declared independent actions. Validation
    ///         and gas reservation happen BEFORE any target is called.
    ///         Every subcall has its own gas cap and result event.
    /// @dev Value for failed calls is credited to the caller. A separate
    ///      withdrawal avoids a rejecting/reentrant refund receiver reverting
    ///      the entire batch. Forced ETH is not spendable by batch callers.
    function execute(Action[] calldata actions)
        external
        payable
        nonReentrant
        onlyAuthorizedCaller
        returns (Result[] memory results)
    {
        uint256 length = actions.length;
        if (length < MIN_ACTIONS || length > MAX_ACTIONS) revert InvalidCount(length);

        uint256 requiredValue;
        uint256 requiredGas = FINISH_RESERVE_GAS;
        for (uint256 i; i < length; ++i) {
            Action calldata action = actions[i];
            if (action.id == bytes32(0)) revert InvalidId(i);
            for (uint256 j; j < i; ++j) {
                if (actions[j].id == action.id) revert DuplicateId(i);
            }
            if (action.target == address(0) || action.target == address(this)) revert InvalidTarget(i);
            uint256 dataLength = action.data.length;
            if (dataLength > MAX_CALLDATA || (dataLength != 0 && dataLength < 4)) {
                revert InvalidCalldata(i);
            }
            // EOA value transfers are allowed only with empty calldata.
            // Precompiles (no bytecode) are deliberately not supported.
            if (dataLength != 0 && action.target.code.length == 0) revert InvalidTarget(i);
            if (action.gasLimit < MIN_CALL_GAS || action.gasLimit > MAX_CALL_GAS) {
                revert InvalidGasLimit(i);
            }
            requiredValue += action.value;
            // EIP-150's 63/64 rule must not eat into subsequent call budgets.
            requiredGas += action.gasLimit + (action.gasLimit + 62) / 63 + ACTION_RESERVE_GAS;
        }
        if (msg.value != requiredValue) revert ValueMismatch(msg.value, requiredValue);
        uint256 available = gasleft();
        if (available < requiredGas) revert InsufficientBatchGas(available, requiredGas);

        results = new Result[](length);
        uint256 succeeded;
        uint256 unusedValue;
        for (uint256 i; i < length; ++i) {
            Action calldata action = actions[i];
            (bool success, bytes memory data, uint256 size) = _boundedCall(action);
            results[i] = Result(success, data, size);
            emit ActionExecuted(i, action.id, action.target, success, data, size);
            if (success) ++succeeded;
            else unusedValue += action.value;
        }

        if (unusedValue != 0) {
            refundCredits[msg.sender] += unusedValue;
            emit RefundCredited(msg.sender, unusedValue);
        }
        emit BatchExecuted(msg.sender, length, succeeded, length - succeeded);
    }

    /// @notice Withdraw ONLY your own failed-call value credit. A failed
    ///         receiver call reverts this withdrawal and preserves the credit.
    function withdrawRefund(address payable recipient) external nonReentrant {
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        uint256 amount = refundCredits[msg.sender];
        if (amount == 0) revert NoRefund();
        refundCredits[msg.sender] = 0;
        (bool success,) = recipient.call{value: amount}("");
        if (!success) revert RefundTransferFailed();
        emit RefundWithdrawn(msg.sender, recipient, amount);
    }

    /// @dev CALL without automatically allocating/copying unbounded returndata.
    ///      The full return size is emitted; only its bounded prefix is copied.
    function _boundedCall(Action calldata action)
        private
        returns (bool success, bytes memory result, uint256 size)
    {
        address target = action.target;
        uint256 value = action.value;
        uint256 callGas = action.gasLimit;
        bytes memory input = action.data;
        uint256 cap = MAX_RETURN_DATA;
        assembly ("memory-safe") {
            success := call(callGas, target, value, add(input, 32), mload(input), 0, 0)
            size := returndatasize()
            let copied := size
            if gt(copied, cap) { copied := cap }
            result := mload(0x40)
            mstore(result, copied)
            returndatacopy(add(result, 32), 0, copied)
            // Allocate length word + data, rounded up to a word boundary.
            mstore(0x40, add(add(result, 32), and(add(copied, 31), not(31))))
        }
    }
}
