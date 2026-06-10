import { Horizon, rpc as SorobanRpc, xdr, StrKey, Address } from '@stellar/stellar-sdk';
import type {
  Network,
  NetworkConfig,
  RecordedTransaction,
  RecordOptions,
  Invocation,
  AssetTransfer,
  LedgerEntryChange,
  InvocationArg,
} from './types.js';
import { NETWORK_CONFIGS, RecorderError } from './types.js';

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Record a Stellar transaction by hash from Horizon.
 */
export async function recordFromHash(
  txHash: string,
  network: Network,
  options: RecordOptions = {},
): Promise<RecordedTransaction> {
  const config = NETWORK_CONFIGS[network];
  const server = new Horizon.Server(config.horizonUrl, { allowHttp: false });

  let horizonTx: Horizon.ServerApi.TransactionRecord;
  try {
    horizonTx = await server.transactions().transaction(txHash).call();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('404')) {
      throw new RecorderError('TX_NOT_FOUND', `Transaction ${txHash} not found on ${network}`, { txHash, network });
    }
    throw new RecorderError('NETWORK_ERROR', `Horizon error: ${message}`, { txHash, network });
  }

  const envelope = xdr.TransactionEnvelope.fromXDR(horizonTx.envelope_xdr, 'base64');
  return parseEnvelope(envelope, {
    hash: txHash,
    network,
    ledger: horizonTx.ledger_attr,
    timestamp: new Date(horizonTx.created_at).getTime() / 1000,
    fee: BigInt(horizonTx.fee_charged),
    rawEnvelope: horizonTx.envelope_xdr,
    config,
    options,
  });
}

/**
 * Record from a Soroban RPC simulation response.
 */
export async function recordFromSimulation(
  simulationResponse: SorobanRpc.Api.SimulateTransactionResponse,
  envelope: xdr.TransactionEnvelope,
  network: Network,
  options: RecordOptions = {},
): Promise<RecordedTransaction> {
  const simAny = simulationResponse as unknown as Record<string, unknown>;
  if ('error' in simAny && typeof simAny.error === 'string') {
    throw new RecorderError('SIMULATION_ERROR', simAny.error, { simulationResponse });
  }

  const rawEnvelope = envelope.toXDR('base64');
  const config = NETWORK_CONFIGS[network];

  return parseEnvelope(envelope, {
    hash: 'simulation',
    network: 'simulation',
    ledger: 0,
    timestamp: Date.now() / 1000,
    fee: 0n,
    rawEnvelope,
    config,
    options,
    simulationResponse: simAny,
  });
}

/**
 * Record from a raw XDR envelope string.
 */
export async function recordFromXdr(
  envelopeXdr: string,
  network: Network,
  options: RecordOptions = {},
): Promise<RecordedTransaction> {
  let envelope: xdr.TransactionEnvelope;
  try {
    envelope = xdr.TransactionEnvelope.fromXDR(envelopeXdr, 'base64');
  } catch {
    throw new RecorderError('DECODE_ERROR', 'Failed to decode XDR envelope', { envelopeXdr });
  }

  const config = NETWORK_CONFIGS[network];

  return parseEnvelope(envelope, {
    hash: 'xdr-input',
    network,
    ledger: 0,
    timestamp: Date.now() / 1000,
    fee: 0n,
    rawEnvelope: envelopeXdr,
    config,
    options,
  });
}

// ---------------------------------------------------------------------------
// Core parsing
// ---------------------------------------------------------------------------

interface ParseContext {
  hash: string;
  network: Network | 'simulation';
  ledger: number;
  timestamp: number;
  fee: bigint;
  rawEnvelope: string;
  config: NetworkConfig;
  options: RecordOptions;
  simulationResponse?: Record<string, unknown>;
}

async function parseEnvelope(
  envelope: xdr.TransactionEnvelope,
  ctx: ParseContext,
): Promise<RecordedTransaction> {
  const maxDepth = ctx.options.maxDepth ?? 10;
  const invocations: Invocation[] = [];
  const assetTransfers: AssetTransfer[] = [];
  const ledgerChanges: LedgerEntryChange[] = [];

  const operations = extractOperations(envelope);

  for (const op of operations) {
    if (op.body().switch() !== xdr.OperationType.invokeHostFunction()) continue;

    const invokeOp = op.body().invokeHostFunctionOp();
    const hostFn = invokeOp.hostFunction();

    if (hostFn.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) continue;

    const invokeArgs = hostFn.invokeContract();
    const topLevelInv = parseInvokeContractArgs(invokeArgs, maxDepth, 0);

    // Populate sub-invocations from the auth tree (contains the full call graph)
    const authEntries = invokeOp.auth();
    attachSubInvocationsFromAuth(topLevelInv, authEntries, maxDepth);

    // Decompose OZ smart account execute() calls into synthetic sub-invocations
    decomposeExecuteCalls(topLevelInv);

    invocations.push(topLevelInv);
    extractAssetTransfers(topLevelInv, assetTransfers);
  }

  if (ctx.simulationResponse) {
    parseLedgerChangesFromSimulation(ctx.simulationResponse, ledgerChanges);
  }

  return {
    hash: ctx.hash,
    network: ctx.network,
    ledger: ctx.ledger,
    timestamp: Math.floor(ctx.timestamp),
    fee: ctx.fee,
    invocations,
    assetTransfers,
    ledgerChanges,
    rawEnvelope: ctx.rawEnvelope,
  };
}

// ---------------------------------------------------------------------------
// Envelope unwrapping — handles v0, v1, and fee-bump envelopes
// ---------------------------------------------------------------------------

function extractOperations(envelope: xdr.TransactionEnvelope): xdr.Operation[] {
  const type = envelope.switch();

  if (type === xdr.EnvelopeType.envelopeTypeTx()) {
    // Standard v1 transaction
    return envelope.v1().tx().operations();
  }

  if (type === xdr.EnvelopeType.envelopeTypeTxFeeBump()) {
    // Fee-bump: unwrap to the inner v1 transaction
    const innerTx = envelope.feeBump().tx().innerTx();
    if (innerTx.switch() === xdr.EnvelopeType.envelopeTypeTx()) {
      return innerTx.v1().tx().operations();
    }
    return [];
  }

  if (type === xdr.EnvelopeType.envelopeTypeTxV0()) {
    // Legacy v0 transaction
    return envelope.v0().tx().operations();
  }

  return [];
}

// ---------------------------------------------------------------------------
// Invocation parsing
// ---------------------------------------------------------------------------

function parseInvokeContractArgs(
  invokeArgs: xdr.InvokeContractArgs,
  maxDepth: number,
  depth: number,
): Invocation {
  const contractId = scAddressToStrKey(invokeArgs.contractAddress());
  const functionName = invokeArgs.functionName().toString();
  const args: InvocationArg[] = invokeArgs.args().map((val, idx) => decodeScVal(val, idx));

  return {
    contractId,
    functionName,
    args,
    subInvocations: [],
    success: true,
  };
}

/**
 * Convert an xdr.ScAddress to a C... StrKey (contract address).
 * Falls back to a hex string if the address is not a contract.
 */
function scAddressToStrKey(scAddr: xdr.ScAddress): string {
  try {
    return Address.fromScAddress(scAddr).toString();
  } catch {
    // If it's not a recognised ScAddress type, fall back gracefully
    try {
      const raw = scAddr.contractId() as unknown as Uint8Array;
      return StrKey.encodeContract(Buffer.from(raw));
    } catch {
      return '[unknown-contract]';
    }
  }
}

// ---------------------------------------------------------------------------
// Auth tree → sub-invocations
// ---------------------------------------------------------------------------

/**
 * Walk auth entries to find the one that authorises topLevelInv, then attach
 * its sub-invocations to the invocation tree.  Multiple signers may have
 * separate entries for the same root call; we take the first match.
 */
function attachSubInvocationsFromAuth(
  topLevelInv: Invocation,
  authEntries: xdr.SorobanAuthorizationEntry[],
  maxDepth: number,
): void {
  for (const entry of authEntries) {
    const root = entry.rootInvocation();
    const fnType = root.function().switch();

    if (
      fnType !==
      xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()
    ) {
      continue;
    }

    const rootFn = root.function().contractFn();
    const rootContractId = scAddressToStrKey(rootFn.contractAddress());
    const rootFnName = rootFn.functionName().toString();

    if (rootContractId === topLevelInv.contractId && rootFnName === topLevelInv.functionName) {
      topLevelInv.subInvocations = root
        .subInvocations()
        .filter(() => 1 < maxDepth) // always include depth-1 subs
        .map((sub) => parseAuthorizedInvocation(sub, maxDepth, 1));
      return;
    }
  }
}

function parseAuthorizedInvocation(
  inv: xdr.SorobanAuthorizedInvocation,
  maxDepth: number,
  depth: number,
): Invocation {
  const fn = inv.function();

  if (
    fn.switch() ===
    xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()
  ) {
    const contractFn = fn.contractFn();
    const invocation = parseInvokeContractArgs(contractFn, maxDepth, depth);
    if (depth < maxDepth) {
      invocation.subInvocations = inv
        .subInvocations()
        .map((sub) => parseAuthorizedInvocation(sub, maxDepth, depth + 1));
    }
    return invocation;
  }

  // create_contract or create_contract_v2
  return {
    contractId: '[create_contract]',
    functionName: 'create_contract',
    args: [],
    subInvocations: [],
    success: true,
  };
}

// ---------------------------------------------------------------------------
// OZ execute() decomposition
// ---------------------------------------------------------------------------

/**
 * OZ smart accounts route calls through execute(target, fn_name, args).
 * When we see this pattern, inject a synthetic child invocation so the
 * policy synthesizer sees the real (contract, function) being called.
 */
function decomposeExecuteCalls(inv: Invocation): void {
  if (inv.functionName === 'execute' && inv.args.length >= 2) {
    const targetArg = inv.args[0];
    const fnArg = inv.args[1];
    const argsArg = inv.args[2];

    if (targetArg?.type === 'address' && (fnArg?.type === 'symbol' || fnArg?.type === 'string')) {
      const childArgs: InvocationArg[] =
        argsArg?.type === 'vec' && Array.isArray(argsArg.value)
          ? (argsArg.value as InvocationArg[])
          : [];

      const synthetic: Invocation = {
        contractId: String(targetArg.value),
        functionName: String(fnArg.value),
        args: childArgs,
        subInvocations: [],
        success: true,
      };

      // Only add if not already present in sub-invocations (auth tree may have it)
      const alreadyPresent = inv.subInvocations.some(
        (s) => s.contractId === synthetic.contractId && s.functionName === synthetic.functionName,
      );
      if (!alreadyPresent) {
        inv.subInvocations.unshift(synthetic);
      }
    }
  }

  for (const sub of inv.subInvocations) {
    decomposeExecuteCalls(sub);
  }
}

// ---------------------------------------------------------------------------
// ScVal decoding
// ---------------------------------------------------------------------------

function decodeScVal(val: xdr.ScVal, index: number): InvocationArg {
  const rawXdr = val.toXDR().toString('base64');
  let type: InvocationArg['type'] = 'unknown';
  let value: unknown = rawXdr;

  const sw = val.switch();

  try {
    if (sw === xdr.ScValType.scvAddress()) {
      type = 'address';
      value = Address.fromScVal(val).toString();
    } else if (sw === xdr.ScValType.scvString()) {
      type = 'string';
      value = val.str().toString();
    } else if (sw === xdr.ScValType.scvSymbol()) {
      type = 'symbol';
      value = val.sym().toString();
    } else if (sw === xdr.ScValType.scvBool()) {
      type = 'bool';
      value = val.b();
    } else if (sw === xdr.ScValType.scvBytes()) {
      type = 'bytes';
      value = (val.bytes() as Buffer).toString('hex');
    } else if (sw === xdr.ScValType.scvI128()) {
      type = 'number';
      const i128 = val.i128();
      // Reconstruct signed i128 from hi (signed i64) and lo (unsigned u64)
      const hi = BigInt(i128.hi().toString());
      const lo = BigInt(i128.lo().toString());
      value = (hi << 64n) | lo;
    } else if (sw === xdr.ScValType.scvI64()) {
      type = 'number';
      value = BigInt(val.i64().toString());
    } else if (sw === xdr.ScValType.scvU128()) {
      type = 'number';
      const u128 = val.u128();
      const hi = BigInt(u128.hi().toString());
      const lo = BigInt(u128.lo().toString());
      value = (hi << 64n) | lo;
    } else if (sw === xdr.ScValType.scvU64()) {
      type = 'number';
      value = BigInt(val.u64().toString());
    } else if (sw === xdr.ScValType.scvU32()) {
      type = 'number';
      value = val.u32();
    } else if (sw === xdr.ScValType.scvI32()) {
      type = 'number';
      value = val.i32();
    } else if (sw === xdr.ScValType.scvVec()) {
      type = 'vec';
      value = (val.vec() ?? []).map((v, i) => decodeScVal(v, i));
    } else if (sw === xdr.ScValType.scvMap()) {
      type = 'map';
      value = Object.fromEntries(
        (val.map() ?? []).map((entry) => [
          decodeScVal(entry.key(), 0).value,
          decodeScVal(entry.val(), 0).value,
        ]),
      );
    }
  } catch {
    // leave as unknown with raw XDR
  }

  return { index, type, value, rawXdr };
}

// ---------------------------------------------------------------------------
// Asset transfer extraction
// ---------------------------------------------------------------------------

function extractAssetTransfers(invocation: Invocation, transfers: AssetTransfer[]): void {
  const fn = invocation.functionName.toLowerCase();
  if (fn === 'transfer' || fn === 'transfer_from') {
    const isTransferFrom = fn === 'transfer_from';
    // transfer(from, to, amount)             → indices 0, 1, 2
    // transfer_from(spender, from, to, amount) → indices 1, 2, 3
    const fromIdx = isTransferFrom ? 1 : 0;
    const toIdx = isTransferFrom ? 2 : 1;
    const amountIdx = isTransferFrom ? 3 : 2;

    const fromArg = invocation.args[fromIdx];
    const toArg = invocation.args[toIdx];
    const amountArg = invocation.args[amountIdx];

    if (fromArg && toArg && amountArg) {
      transfers.push({
        assetCode: invocation.contractId, // full C-address; caller can resolve to ticker
        from: String(fromArg.value),
        to: String(toArg.value),
        amount: typeof amountArg.value === 'bigint' ? amountArg.value : 0n,
        sourceInvocation: `${invocation.contractId}::${invocation.functionName}`,
      });
    }
  }

  for (const sub of invocation.subInvocations) {
    extractAssetTransfers(sub, transfers);
  }
}

// ---------------------------------------------------------------------------
// Ledger changes from simulation
// ---------------------------------------------------------------------------

function parseLedgerChangesFromSimulation(
  sim: Record<string, unknown>,
  changes: LedgerEntryChange[],
): void {
  if (!('stateChanges' in sim) || !Array.isArray(sim.stateChanges)) return;

  for (const change of sim.stateChanges as Array<{
    type: string;
    key: { toXDR(fmt: string): string };
    before?: { toXDR(fmt: string): string };
    after?: { toXDR(fmt: string): string };
  }>) {
    changes.push({
      type: change.type as 'created' | 'updated' | 'deleted',
      keyXdr: change.key.toXDR('base64'),
      oldValueXdr: change.before?.toXDR('base64'),
      newValueXdr: change.after?.toXDR('base64'),
    });
  }
}
