/**
 * Wallet integration for OZ Smart Account policy installation.
 *
 * Provides helpers for:
 *   - Building the `add_context_rule` + `add_policy` host-function XDR
 *   - Building `execute(target, fn, args)` host-function XDR
 *   - Submitting transactions via the OZ Channels relayer
 *
 * OZ smart account interface (stellar-accounts):
 *   add_context_rule(context_type, name, valid_until, signers, policies_map) -> u32
 *   add_policy(rule_id: u32, policy_addr: Address, params: Val)
 *   execute(target: Address, fn_name: Symbol, args: Vec<Val>)
 *
 * The Channels relayer (OZ off-chain infrastructure) accepts unsigned
 * Soroban operations signed by an ephemeral key and forwards them through
 * the smart account's authorization flow.
 */

import {
  Address,
  Contract,
  nativeToScVal,
  scValToNative,
  xdr,
  Networks,
  TransactionBuilder,
  SorobanDataBuilder,
} from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BuildContextRuleTxParams {
  /** C-address of the OZ smart account contract. */
  walletContractId: string;
  /** Human-readable rule name (stored on-chain). */
  ruleName: string;
  /**
   * Target contract for a CallContract rule. Pass empty string for a Default rule.
   * Determines the ContextRuleType passed to add_context_rule.
   */
  targetContract: string;
  /** Address of the deployed policy contract to attach. */
  policyAddr: string;
  /** Base64-encoded XDR of the typed install params struct (policy-specific). */
  installParamsXdr: string;
  /** Network passphrase — determines which Stellar network to target. */
  networkPassphrase: string;
  /** Valid-until ledger sequence number. undefined = no expiry. */
  validUntilLedger?: number;
}

export interface BuiltTransaction {
  /** Base64-encoded XDR of the InvokeHostFunction operation. */
  hostFuncXdr: string;
  /** Ephemeral keypair public key (Stellar G-address) that signs this tx. */
  ephemeralPublicKey: string;
}

export interface BuildExecuteTxParams {
  /** C-address of the OZ smart account contract. */
  walletContractId: string;
  /** Contract to call via execute(). */
  targetContract: string;
  /** Function name to invoke on the target. */
  functionName: string;
  /** Arguments to pass, each as an xdr.ScVal. */
  args: xdr.ScVal[];
}

export interface RelayerSubmitResult {
  txHash: string;
  status: 'pending' | 'success' | 'failed';
  error?: string;
}

// ---------------------------------------------------------------------------
// ContextRuleType helpers (mirrors the Rust enum in stellar-accounts)
// ---------------------------------------------------------------------------

export type ContextRuleTypeTag = 'Default' | 'CallContract' | 'CreateContract';

function buildContextRuleType(tag: ContextRuleTypeTag, targetContract?: string): xdr.ScVal {
  if (tag === 'Default') {
    return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Default')]);
  }
  if (tag === 'CallContract' && targetContract) {
    return xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol('CallContract'),
      new Address(targetContract).toScVal(),
    ]);
  }
  // Default fallback
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Default')]);
}

// ---------------------------------------------------------------------------
// Build add_context_rule + add_policy call XDR
// ---------------------------------------------------------------------------

/**
 * Build the host-function XDR for installing a policy on an OZ smart account.
 *
 * Pattern:
 *   1. Call add_context_rule → returns rule_id: u32
 *   2. Call add_policy(rule_id, policy_addr, params)
 *
 * Since Soroban doesn't support multi-step sequences in a single operation,
 * this returns two separate operation XDRs. The caller must submit them as
 * separate transactions or use the relayer's batching support.
 *
 * Returns base64-encoded InvokeHostFunction XDR strings.
 */
export function buildAddContextRuleTx(params: BuildContextRuleTxParams): {
  addContextRuleXdr: string;
  addPolicyXdrTemplate: string;
} {
  const walletContract = new Contract(params.walletContractId);

  // Determine rule type
  const ruleTag: ContextRuleTypeTag =
    params.targetContract && params.targetContract.startsWith('C')
      ? 'CallContract'
      : 'Default';

  const contextRuleType = buildContextRuleType(ruleTag, params.targetContract);

  // add_context_rule(context_type, name, valid_until, signers, policies_map)
  //   signers: Vec<Signer> — empty (caller adds signers separately)
  //   policies_map: Map<Address, Vec<Val>> — empty initially; policies added via add_policy
  const addContextRuleArgs: xdr.ScVal[] = [
    contextRuleType,
    xdr.ScVal.scvString(params.ruleName),
    params.validUntilLedger !== undefined
      ? xdr.ScVal.scvVec([xdr.ScVal.scvU32(params.validUntilLedger)]) // Some(ledger)
      : xdr.ScVal.scvVec([]),                                           // None
    xdr.ScVal.scvVec([]),    // signers: Vec<Signer>
    xdr.ScVal.scvMap([]),    // policies_map: Map<Address, Vec<Val>>
  ];

  const addContextRuleOp = walletContract.call('add_context_rule', ...addContextRuleArgs);
  const addContextRuleXdr = addContextRuleOp.toXDR('base64');

  // add_policy(rule_id: u32, policy_addr: Address, params: Val)
  // rule_id is not yet known (returned by add_context_rule at runtime).
  // The template uses placeholder rule_id = 0; the caller must substitute
  // the actual ID returned by the add_context_rule transaction.
  const policyAddress = new Address(params.policyAddr);
  const installParams = xdr.ScVal.fromXDR(params.installParamsXdr, 'base64');

  const addPolicyArgs: xdr.ScVal[] = [
    xdr.ScVal.scvU32(0), // placeholder rule_id — substitute with actual value
    policyAddress.toScVal(),
    installParams,
  ];

  const addPolicyOp = walletContract.call('add_policy', ...addPolicyArgs);
  const addPolicyXdrTemplate = addPolicyOp.toXDR('base64');

  return { addContextRuleXdr, addPolicyXdrTemplate };
}

/**
 * Patch a pre-built add_policy XDR template to use the actual rule_id
 * returned by a successful add_context_rule transaction.
 */
export function patchAddPolicyRuleId(addPolicyXdr: string, ruleId: number): string {
  const op = xdr.Operation.fromXDR(addPolicyXdr, 'base64');
  const invokeOp = op.body().invokeHostFunctionOp();
  const invokeArgs = invokeOp.hostFunction().invokeContract();
  const args = invokeArgs.args();
  // Replace index 0 (rule_id placeholder) with actual value
  args[0] = xdr.ScVal.scvU32(ruleId);
  return op.toXDR('base64');
}

// ---------------------------------------------------------------------------
// Build execute() XDR
// ---------------------------------------------------------------------------

/**
 * Build the host-function XDR for calling execute() on an OZ smart account.
 * execute(target: Address, fn_name: Symbol, args: Vec<Val>)
 */
export function buildPolicyExecuteTx(params: BuildExecuteTxParams): string {
  const walletContract = new Contract(params.walletContractId);
  const target = new Address(params.targetContract);

  const executeArgs: xdr.ScVal[] = [
    target.toScVal(),
    xdr.ScVal.scvSymbol(params.functionName),
    xdr.ScVal.scvVec(params.args),
  ];

  const op = walletContract.call('execute', ...executeArgs);
  return op.toXDR('base64');
}

// ---------------------------------------------------------------------------
// OZ Channels relayer submission
// ---------------------------------------------------------------------------

export interface RelayerConfig {
  /** URL of the OZ Channels relayer endpoint. */
  relayerUrl: string;
  /** API key for the relayer service. */
  apiKey?: string;
  /** Network passphrase. */
  networkPassphrase: string;
  /** Soroban RPC URL for transaction tracking. */
  sorobanRpcUrl?: string;
}

/**
 * Submit a signed Soroban operation to the OZ Channels relayer.
 *
 * The relayer accepts an unsigned operation XDR, adds the smart account's
 * authorization, pays fees, and broadcasts the transaction. It returns
 * the final transaction hash.
 *
 * Note: In production, the @openzeppelin/relayer-plugin-channels package
 * handles the full signing protocol (policy-gated authorization). This
 * function implements the HTTP relay submission layer.
 */
export async function submitViaRelayer(
  operationXdr: string,
  ephemeralPublicKey: string,
  config: RelayerConfig,
): Promise<RelayerSubmitResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  const body = JSON.stringify({
    operation: operationXdr,
    ephemeral_public_key: ephemeralPublicKey,
    network_passphrase: config.networkPassphrase,
  });

  let response: Response;
  try {
    response = await fetch(`${config.relayerUrl}/v1/relay`, { method: 'POST', headers, body });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { txHash: '', status: 'failed', error: `Network error: ${msg}` };
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    return { txHash: '', status: 'failed', error: `Relayer HTTP ${response.status}: ${errText}` };
  }

  const result = (await response.json()) as { tx_hash?: string; status?: string; error?: string };
  return {
    txHash: result.tx_hash ?? '',
    status: result.status === 'success' ? 'success' : 'pending',
    error: result.error,
  };
}

/**
 * Poll the Soroban RPC for the final status of a submitted transaction.
 * Returns when the transaction reaches SUCCESS or FAILED, or times out.
 */
export async function waitForTransaction(
  txHash: string,
  sorobanRpcUrl: string,
  timeoutMs = 30_000,
  pollIntervalMs = 2_000,
): Promise<{ success: boolean; resultXdr?: string; error?: string }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    try {
      const resp = await fetch(sorobanRpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: { hash: txHash },
        }),
      });
      const json = (await resp.json()) as {
        result?: { status: string; resultXdr?: string; errorResultXdr?: string };
      };
      const status = json.result?.status;
      if (status === 'SUCCESS') {
        return { success: true, resultXdr: json.result?.resultXdr };
      }
      if (status === 'FAILED') {
        return { success: false, error: json.result?.errorResultXdr };
      }
      // PENDING / NOT_FOUND — keep polling
    } catch {
      // transient RPC error — keep polling
    }
  }

  return { success: false, error: 'timeout waiting for transaction' };
}

// ---------------------------------------------------------------------------
// Typed install-param XDR builders
// ---------------------------------------------------------------------------

/** Encode TimeBoundParams as XDR for add_policy. */
export function encodeTimeBoundParams(startLedger: number, endLedger: number): string {
  const val = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('start_ledger'),
      val: xdr.ScVal.scvU32(startLedger),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('end_ledger'),
      val: xdr.ScVal.scvU32(endLedger),
    }),
  ]);
  return val.toXDR('base64');
}

/** Encode SpendingLimitParams as XDR for add_policy. */
export function encodeSpendingLimitParams(
  assetContractId: string,
  limitAmount: bigint,
  periodSecs: number,
): string {
  const hi = limitAmount >> 64n;
  const lo = limitAmount & 0xFFFFFFFFFFFFFFFFn;
  const val = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('asset'),
      val: new Address(assetContractId).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('limit'),
      val: xdr.ScVal.scvI128(
        new xdr.Int128Parts({ hi: xdr.Int64.fromString(hi.toString()), lo: xdr.Uint64.fromString(lo.toString()) }),
      ),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('period_secs'),
      val: xdr.ScVal.scvU64(xdr.Uint64.fromString(periodSecs.toString())),
    }),
  ]);
  return val.toXDR('base64');
}

/** Encode FrequencyLimitParams as XDR for add_policy. */
export function encodeFrequencyLimitParams(maxCalls: number, windowSecs: number): string {
  const val = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('max_calls'),
      val: xdr.ScVal.scvU32(maxCalls),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('window_secs'),
      val: xdr.ScVal.scvU64(xdr.Uint64.fromString(windowSecs.toString())),
    }),
  ]);
  return val.toXDR('base64');
}

/** Encode CallFilterParams (allowed_calls list) as XDR for add_policy. */
export function encodeCallFilterParams(
  allowedCalls: Array<{
    contractId: string;
    fnName: string;
    argConstraints?: Array<
      | { type: 'ExactAddress'; position: number; address: string }
      | { type: 'ExactValue'; position: number; value: bigint }
      | { type: 'AmountMax'; position: number; max: bigint }
      | { type: 'AmountMin'; position: number; min: bigint }
    >;
  }>,
): string {
  const callsVec = xdr.ScVal.scvVec(
    allowedCalls.map((call) => {
      const constraints = (call.argConstraints ?? []).map((c) => {
        if (c.type === 'ExactAddress') {
          return xdr.ScVal.scvVec([
            xdr.ScVal.scvSymbol('ExactAddress'),
            xdr.ScVal.scvU32(c.position),
            new Address(c.address).toScVal(),
          ]);
        }
        if (c.type === 'ExactValue') {
          return xdr.ScVal.scvVec([
            xdr.ScVal.scvSymbol('ExactValue'),
            xdr.ScVal.scvU32(c.position),
            nativeToScVal(c.value, { type: 'i128' }),
          ]);
        }
        if (c.type === 'AmountMax') {
          return xdr.ScVal.scvVec([
            xdr.ScVal.scvSymbol('AmountMax'),
            xdr.ScVal.scvU32(c.position),
            nativeToScVal(c.max, { type: 'i128' }),
          ]);
        }
        // AmountMin
        return xdr.ScVal.scvVec([
          xdr.ScVal.scvSymbol('AmountMin'),
          xdr.ScVal.scvU32(c.position),
          nativeToScVal((c as { min: bigint }).min, { type: 'i128' }),
        ]);
      });

      return xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('contract'),
          val: new Address(call.contractId).toScVal(),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('fn_name'),
          val: xdr.ScVal.scvSymbol(call.fnName),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('arg_constraints'),
          val: xdr.ScVal.scvVec(constraints),
        }),
      ]);
    }),
  );

  const val = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('allowed_calls'),
      val: callsVec,
    }),
  ]);
  return val.toXDR('base64');
}
