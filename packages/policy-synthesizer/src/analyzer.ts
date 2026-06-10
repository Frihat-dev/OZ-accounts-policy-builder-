/**
 * Transaction analysis layer.
 * Extracts structured facts from recorded transactions that the synthesizer
 * then turns into policy specs.
 */

import type { RecordedTransaction, Invocation, AssetTransfer } from '@oz-policy-builder/tx-recorder';
import type { ScopeEntry } from './types.js';

export interface AnalyzedFacts {
  /** Deduplicated (contractId, functionName) pairs observed. */
  scope: ScopeEntry[];
  /** Asset spending observed: assetId → max single-transfer amount. */
  assetSpending: Map<string, AssetSpendingFact>;
  /** Unique recipient addresses per asset (for call-filter arg constraints). */
  recipientsByAsset: Map<string, Set<string>>;
  /** Minimum timestamp across all transactions. */
  minTimestamp: number;
  /** Maximum timestamp across all transactions. */
  maxTimestamp: number;
  /** Total number of transactions analyzed. */
  txCount: number;
  /** Call frequencies: contractId::fnName → count. */
  callFrequency: Map<string, number>;
}

export interface AssetSpendingFact {
  assetId: string;
  maxSingleTransfer: bigint;
  totalSpend: bigint;
  transferCount: number;
  directions: Array<'outbound' | 'inbound' | 'internal'>;
}

/**
 * Analyze one or more recorded transactions and extract structured facts.
 */
export function analyzeTransactions(
  txs: RecordedTransaction[],
  smartAccountId?: string,
): AnalyzedFacts {
  const scopeMap = new Map<string, ScopeEntry>();
  const assetSpending = new Map<string, AssetSpendingFact>();
  const recipientsByAsset = new Map<string, Set<string>>();
  const callFrequency = new Map<string, number>();
  let minTimestamp = Infinity;
  let maxTimestamp = -Infinity;

  for (const tx of txs) {
    if (tx.timestamp > 0) {
      minTimestamp = Math.min(minTimestamp, tx.timestamp);
      maxTimestamp = Math.max(maxTimestamp, tx.timestamp);
    }

    // Walk the full invocation tree
    for (const inv of tx.invocations) {
      walkInvocation(inv, scopeMap, callFrequency);
    }

    // Process asset transfers
    for (const transfer of tx.assetTransfers) {
      processTransfer(transfer, smartAccountId, assetSpending, recipientsByAsset);
    }
  }

  return {
    scope: Array.from(scopeMap.values()),
    assetSpending,
    recipientsByAsset,
    minTimestamp: isFinite(minTimestamp) ? minTimestamp : Date.now() / 1000,
    maxTimestamp: isFinite(maxTimestamp) ? maxTimestamp : Date.now() / 1000,
    txCount: txs.length,
    callFrequency,
  };
}

function walkInvocation(
  inv: Invocation,
  scopeMap: Map<string, ScopeEntry>,
  callFreq: Map<string, number>,
): void {
  const key = `${inv.contractId}::${inv.functionName}`;

  if (!scopeMap.has(key)) {
    scopeMap.set(key, {
      contractId: inv.contractId,
      contractName: inv.contractName,
      functionName: inv.functionName,
    });
  }

  callFreq.set(key, (callFreq.get(key) ?? 0) + 1);

  for (const sub of inv.subInvocations) {
    walkInvocation(sub, scopeMap, callFreq);
  }
}

function processTransfer(
  transfer: AssetTransfer,
  smartAccountId: string | undefined,
  assetSpending: Map<string, AssetSpendingFact>,
  recipientsByAsset: Map<string, Set<string>>,
): void {
  const assetId = transfer.assetCode + (transfer.issuer ? `:${transfer.issuer}` : '');

  if (!assetSpending.has(assetId)) {
    assetSpending.set(assetId, {
      assetId,
      maxSingleTransfer: 0n,
      totalSpend: 0n,
      transferCount: 0,
      directions: [],
    });
  }

  const fact = assetSpending.get(assetId)!;
  fact.transferCount++;
  if (transfer.amount > fact.maxSingleTransfer) {
    fact.maxSingleTransfer = transfer.amount;
  }

  // Determine direction relative to smart account
  let direction: 'outbound' | 'inbound' | 'internal' = 'internal';
  if (smartAccountId) {
    if (transfer.from === smartAccountId) {
      direction = 'outbound';
      fact.totalSpend += transfer.amount;
    } else if (transfer.to === smartAccountId) {
      direction = 'inbound';
    }
  } else {
    // No account known: treat all as outbound
    direction = 'outbound';
    fact.totalSpend += transfer.amount;
  }
  fact.directions.push(direction);

  // Track recipients for call-filter generation
  if (!recipientsByAsset.has(assetId)) {
    recipientsByAsset.set(assetId, new Set());
  }
  recipientsByAsset.get(assetId)!.add(transfer.to);
}

// ---------------------------------------------------------------------------
// Policy selection heuristics
// ---------------------------------------------------------------------------

export type PolicyHint =
  | { type: 'spending_limit'; assetId: string; amount: bigint; periodSeconds: number }
  | { type: 'call_filter'; contractId: string; functionName: string; recipientAddress?: string }
  | { type: 'time_bound'; startLedger: number; endLedger: number }
  | { type: 'frequency_limit'; maxCalls: number; windowSeconds: number };

/**
 * Heuristically determine which policies to propose based on the analyzed facts.
 */
export function derivePolicyHints(
  facts: AnalyzedFacts,
  smartAccountId?: string,
): PolicyHint[] {
  const hints: PolicyHint[] = [];

  // 1. Spending limits for every outbound asset
  for (const [, spending] of facts.assetSpending) {
    if (spending.directions.includes('outbound') || !smartAccountId) {
      hints.push({
        type: 'spending_limit',
        assetId: spending.assetId,
        amount: spending.maxSingleTransfer,
        periodSeconds: 86400, // default: daily limit, user can adjust
      });
    }
  }

  // 2. Call filters if recipients are narrow (single recipient = fixed arg constraint)
  for (const [assetId, recipients] of facts.recipientsByAsset) {
    if (recipients.size === 1) {
      const recipient = Array.from(recipients)[0];
      // Find the transfer invocation for this asset
      for (const scope of facts.scope) {
        if (scope.functionName === 'transfer' || scope.functionName === 'transfer_from') {
          hints.push({
            type: 'call_filter',
            contractId: scope.contractId,
            functionName: scope.functionName,
            recipientAddress: recipient,
          });
          break;
        }
      }
    }
  }

  // 3. Frequency limit if same call appears many times across few txs
  for (const [callKey, count] of facts.callFrequency) {
    const callsPerTx = count / facts.txCount;
    if (callsPerTx <= 1 && facts.txCount >= 2) {
      // Only called once per tx across multiple txs — hint at daily frequency limit
      const [contractId, functionName] = callKey.split('::');
      // Don't add frequency limit for transfer functions (covered by spending limit)
      if (functionName !== 'transfer' && functionName !== 'transfer_from') {
        hints.push({
          type: 'frequency_limit',
          maxCalls: Math.ceil(callsPerTx * 1.5), // 50% headroom
          windowSeconds: 86400,
        });
      }
    }
  }

  return hints;
}
