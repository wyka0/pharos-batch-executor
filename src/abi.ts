import { parseAbi } from 'viem';

export const BATCH_EXECUTOR_ABI = parseAbi([
  'function execute((bytes32 id,address target,uint256 value,uint256 gasLimit,bytes data)[] actions) payable returns ((bool success,bytes data,uint256 returnDataSize)[] results)',
  'function refundCredits(address sender) view returns (uint256)',
  'function withdrawRefund(address recipient)',
  'event ActionExecuted(uint256 indexed index,bytes32 indexed id,address indexed target,bool success,bytes result,uint256 returnDataSize)',
  'event BatchExecuted(address indexed sender,uint256 total,uint256 succeeded,uint256 failed)',
  'event RefundCredited(address indexed sender,uint256 amount)',
  'event RefundWithdrawn(address indexed sender,address indexed recipient,uint256 amount)',
  'error InvalidCount(uint256 count)',
  'error InvalidId(uint256 index)',
  'error DuplicateId(uint256 index)',
  'error InvalidTarget(uint256 index)',
  'error InvalidCalldata(uint256 index)',
  'error InvalidGasLimit(uint256 index)',
  'error ValueMismatch(uint256 supplied,uint256 required)',
  'error InsufficientBatchGas(uint256 available,uint256 required)',
  'error ReentrantCall()',
  'error InvalidRecipient()',
  'error NoRefund()',
  'error RefundTransferFailed()',
]);

export const TEST_ONLY_COUNTER_ABI = parseAbi([
  'function slots(bytes32 key) view returns (uint256)',
  'function setValue(bytes32 key,uint256 value) returns (uint256)',
  'function fail() pure',
  'function burnGas() pure',
  'function largeReturn(uint256 size) pure returns (bytes)',
  'function deposit() payable returns (uint256)',
  'function returnFalse() pure returns (bool)',
]);
