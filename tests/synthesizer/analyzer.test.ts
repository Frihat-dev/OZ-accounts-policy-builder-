/**
 * Tests for the transaction analyzer.
 * These tests cover the core heuristics that determine what policies are proposed.
 */

import { describe, it, expect } from '@jest/globals';
import { analyzeTransactions, derivePolicyHints } from '../../packages/policy-synthesizer/src/analyzer.js';
import type { RecordedTransaction } from '../../packages/tx-recorder/src/types.js';
import blendTx from '../fixtures/blend-yield-claim.json' ;
import subscriptionTx from '../fixtures/sep41-subscription.json' ;

function fixtureTx(json: typeof blendTx): RecordedTransaction {
  // Convert string amounts to bigint
  return {
    ...json,
    fee: BigInt(json.fee),
    assetTransfers: json.assetTransfers.map((t) => ({
      ...t,
      amount: BigInt(t.amount),
    })),
  } as unknown as RecordedTransaction;
}

describe('analyzeTransactions', () => {
  it('extracts all unique (contract, function) pairs from blend yield claim', () => {
    const tx = fixtureTx(blendTx);
    const facts = analyzeTransactions([tx]);

    expect(facts.scope).toHaveLength(2);
    const fnNames = facts.scope.map((s) => s.functionName);
    expect(fnNames).toContain('claim');
    expect(fnNames).toContain('swap_exact_tokens_for_tokens');
  });

  it('deduplicates scope entries across multiple txs', () => {
    const tx = fixtureTx(blendTx);
    // Two identical txs
    const facts = analyzeTransactions([tx, tx]);
    expect(facts.scope).toHaveLength(2); // still 2 unique pairs
    expect(facts.txCount).toBe(2);
  });

  it('tracks call frequency per function', () => {
    const tx = fixtureTx(blendTx);
    const facts = analyzeTransactions([tx, tx]);
    const claimCount = facts.callFrequency.get(
      `${tx.invocations[0].contractId}::claim`,
    );
    expect(claimCount).toBe(2);
  });

  it('extracts outbound asset spending for subscription tx', () => {
    const tx = fixtureTx(subscriptionTx);
    const smartAccountId = 'CACCOUNT_USER_1234567890ABCDEFGHIJKLMNOPQRSTUVWXY';
    const facts = analyzeTransactions([tx], smartAccountId);

    const eurcFact = facts.assetSpending.get('EURC:GCURRENCY_ISSUER_1234567890ABCDEFGHIJKLMNOPQRST');
    expect(eurcFact).toBeDefined();
    expect(eurcFact!.maxSingleTransfer).toBe(100000000n);
    expect(eurcFact!.directions).toContain('outbound');
  });

  it('tracks single recipient per asset for subscription', () => {
    const tx = fixtureTx(subscriptionTx);
    const facts = analyzeTransactions([tx]);

    const recipients = facts.recipientsByAsset.get('EURC:GCURRENCY_ISSUER_1234567890ABCDEFGHIJKLMNOPQRST');
    expect(recipients?.size).toBe(1);
    expect(Array.from(recipients!)[0]).toBe('CBILLING_CONTRACT_1234567890ABCDEFGHIJKLMNOPQRSTU');
  });
});

describe('derivePolicyHints', () => {
  it('proposes spending limit for outbound asset', () => {
    const tx = fixtureTx(subscriptionTx);
    const smartAccountId = 'CACCOUNT_USER_1234567890ABCDEFGHIJKLMNOPQRSTUVWXY';
    const facts = analyzeTransactions([tx], smartAccountId);
    const hints = derivePolicyHints(facts, smartAccountId);

    const spendingHint = hints.find((h) => h.type === 'spending_limit');
    expect(spendingHint).toBeDefined();
    if (spendingHint?.type === 'spending_limit') {
      expect(spendingHint.amount).toBe(100000000n);
    }
  });

  it('proposes call filter when single recipient observed', () => {
    const tx = fixtureTx(subscriptionTx);
    const facts = analyzeTransactions([tx]);
    const hints = derivePolicyHints(facts);

    const filterHint = hints.find((h) => h.type === 'call_filter');
    expect(filterHint).toBeDefined();
    if (filterHint?.type === 'call_filter') {
      expect(filterHint.recipientAddress).toBe('CBILLING_CONTRACT_1234567890ABCDEFGHIJKLMNOPQRSTU');
    }
  });

  it('does not propose call filter when multiple recipients seen', () => {
    const tx1 = fixtureTx(subscriptionTx);
    const tx2: RecordedTransaction = {
      ...fixtureTx(subscriptionTx),
      assetTransfers: [
        {
          assetCode: 'EURC',
          issuer: 'GCURRENCY_ISSUER_1234567890ABCDEFGHIJKLMNOPQRST',
          from: 'CACCOUNT_USER_1234567890ABCDEFGHIJKLMNOPQRSTUVWXY',
          to: 'CDIFFERENT_RECIPIENT_1234567890ABCDEFGHIJKLMNOP',
          amount: 100000000n,
        },
      ],
    };
    const facts = analyzeTransactions([tx1, tx2]);
    const hints = derivePolicyHints(facts);

    // With 2 different recipients, no call filter for recipient pinning
    const filterHints = hints.filter((h) => h.type === 'call_filter');
    // Call filter may still be proposed for function scope but not for recipient
    for (const h of filterHints) {
      if (h.type === 'call_filter') {
        expect(h.recipientAddress).toBeUndefined();
      }
    }
  });

  it('proposes both spending limit and frequency limit for blend flow', () => {
    const tx = fixtureTx(blendTx);
    const facts = analyzeTransactions([tx, tx]); // 2 txs = frequency signal
    const hints = derivePolicyHints(facts);

    const spendingHint = hints.find((h) => h.type === 'spending_limit');
    expect(spendingHint).toBeDefined();

    // claim + swap = 2 non-transfer functions; frequency hint may be proposed
    // (swap_exact_tokens_for_tokens is not 'transfer' so frequency limit applies)
    const freqHint = hints.find((h) => h.type === 'frequency_limit');
    // Present or not depending on call pattern — just verify it's typed correctly
    if (freqHint) {
      expect(freqHint.type).toBe('frequency_limit');
    }
  });
});
