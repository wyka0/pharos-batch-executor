// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Test-only sender-independent state target. Writes to DISTINCT keys
///         are independent. NOT a token, vault, swap, or production protocol.
contract TestOnlyCounter {
    mapping(bytes32 => uint256) public slots;
    event ValueSet(bytes32 indexed key, uint256 value);

    function setValue(bytes32 key, uint256 value) external returns (uint256) {
        slots[key] = value;
        emit ValueSet(key, value);
        return value;
    }

    function fail() external pure {
        revert("TestOnly: forced failure");
    }

    function burnGas() external pure {
        assembly { for {} 1 {} {} }
    }

    function largeReturn(uint256 size) external pure returns (bytes memory) {
        return new bytes(size);
    }

    function deposit() external payable returns (uint256) {
        return msg.value;
    }

    function returnFalse() external pure returns (bool) {
        return false;
    }
}
