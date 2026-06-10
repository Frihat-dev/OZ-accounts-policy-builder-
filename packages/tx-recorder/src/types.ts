// Core types for the transaction recording layer

export type Network = 'mainnet' | 'testnet' | 'futurenet';

export interface NetworkConfig {
  horizonUrl: string;
  sorobanRpcUrl: string;
  networkPassphrase: string;
}

export const NETWORK_CONFIGS: Record<Network, NetworkConfig> = {
  mainnet: {
    horizonUrl: 'https://horizon.stellar.org',
    sorobanRpcUrl: 'https://mainnet.sorobanrpc.com',
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
  },
  testnet: {
    horizonUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
  },
  futurenet: {
    horizonUrl: 'https://horizon-futurenet.stellar.org',
    sorobanRpcUrl: 'https://rpc-futurenet.stellar.org',
    networkPassphrase: 'Test SDF Future Network ; October 2022',
  },
};

// ---------------------------------------------------------------------------
// Core output types
// ---------------------------------------------------------------------------

export interface RecordedTransaction {
  /** Transaction hash (hex). */
  hash: string;
  /** Source network or 'simulation'. */
  network: Network | 'simulation';
  /** Ledger sequence number at close. 0 for simulations. */
  ledger: number;
  /** Unix timestamp of ledger close (seconds). 0 for simulations. */
  timestamp: number;
  /** Transaction fee in stroops. */
  fee: bigint;
  /** All contract invocations (top-level and sub-invocations). */
  invocations: Invocation[];
  /** SAC token transfers extracted from the transaction. */
  assetTransfers: AssetTransfer[];
  /** Ledger entry changes (creates, updates, deletes). */
  ledgerChanges: LedgerEntryChange[];
  /** Raw XDR envelope (base64). */
  rawEnvelope: string;
}

export interface Invocation {
  /** Soroban contract address (C-address). */
  contractId: string;
  /** Human-readable contract name if resolvable from metadata. */
  contractName?: string;
  /** Function name called. */
  functionName: string;
  /** Decoded arguments. */
  args: InvocationArg[];
  /** Nested sub-invocations made by this contract. */
  subInvocations: Invocation[];
  /** Whether this invocation succeeded. */
  success: boolean;
  /** Return value if available and decodable. */
  returnValue?: unknown;
}

export interface InvocationArg {
  /** Argument index (0-based). */
  index: number;
  /** Type hint derived from the Soroban XDR value type. */
  type: 'address' | 'string' | 'number' | 'bool' | 'bytes' | 'symbol' | 'vec' | 'map' | 'unknown';
  /** Decoded value. */
  value: unknown;
  /** Raw XDR (base64) for round-tripping. */
  rawXdr: string;
}

export interface AssetTransfer {
  /** Asset code (e.g. "USDC", "XLM"). */
  assetCode: string;
  /** Issuer address (undefined for native XLM). */
  issuer?: string;
  /** Sender address. */
  from: string;
  /** Recipient address. */
  to: string;
  /** Amount in base units (7 decimal places for SAC tokens). */
  amount: bigint;
  /** The invocation that triggered this transfer. */
  sourceInvocation?: string; // contract call identifier
}

export interface LedgerEntryChange {
  type: 'created' | 'updated' | 'deleted';
  /** XDR of the ledger entry key. */
  keyXdr: string;
  /** XDR of the old entry value (undefined for created). */
  oldValueXdr?: string;
  /** XDR of the new entry value (undefined for deleted). */
  newValueXdr?: string;
  /** Resolved description if possible. */
  description?: string;
}

// ---------------------------------------------------------------------------
// Recording options
// ---------------------------------------------------------------------------

export interface RecordOptions {
  /** Resolve contract names from known registries. Default: true. */
  resolveNames?: boolean;
  /** Include ledger entry changes in the output. Default: true. */
  includeLedgerChanges?: boolean;
  /** Maximum sub-invocation depth to traverse. Default: 10. */
  maxDepth?: number;
  /** Custom Soroban RPC URL (overrides network default). */
  rpcUrl?: string;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class RecorderError extends Error {
  constructor(
    public code: RecorderErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'RecorderError';
  }
}

export type RecorderErrorCode =
  | 'TX_NOT_FOUND'
  | 'NETWORK_ERROR'
  | 'DECODE_ERROR'
  | 'SIMULATION_ERROR'
  | 'UNSUPPORTED_TX_TYPE';
