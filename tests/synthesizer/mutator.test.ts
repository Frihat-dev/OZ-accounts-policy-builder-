/**
 * Tests for the deny-case mutator.
 */

import { describe, it, expect } from '@jest/globals';
import { applyMutation, generateDenyCases } from '../../packages/sim-harness/src/mutator.js';
import type { RecordedTransaction } from '../../packages/tx-recorder/src/types.js';
import subscriptionJson from '../fixtures/sep41-subscription.json' ;
import type { GeneratedCode } from '../../packages/policy-synthesizer/src/types.js';

function fixtureTx(json: typeof subscriptionJson): RecordedTransaction {
  return {
    ...json,
    fee: BigInt(json.fee),
    assetTransfers: json.assetTransfers.map((t) => ({
      ...t,
      amount: BigInt(t.amount),
    })),
  } as unknown as RecordedTransaction;
}

function makeGeneratedCode(): GeneratedCode {
  return {
    proposalId: 'test-proposal',
    contextRuleConfig: {
      label: 'Test Rule',
      scope: [
        { contractId: 'CEURC_TOKEN_1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ0', functionName: 'transfer' },
      ],
      lifetime: { type: 'duration_seconds', durationSeconds: 86400, description: '1 day' },
      policyAddresses: [],
    },
    standardPolicyConfigs: [
      {
        policyKind: 'oz_spending_limit',
        ozContractName: 'SpendingLimitPolicy',
        config: {
          kind: 'oz_spending_limit',
          assetContractId: 'CEURC_TOKEN_1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ0',
          limitAmount: 100000000n,
          periodSeconds: 2592000,
        },
      },
    ],
    customPolicySources: [],
    installScript: '',
  };
}

describe('applyMutation', () => {
  it('exceed_spending: multiplies all transfer amounts', () => {
    const tx = fixtureTx(subscriptionJson);
    const mutated = applyMutation(tx, { type: 'exceed_spending', factor: 10 });

    expect(mutated.assetTransfers[0].amount).toBe(100000000n * 10n);
  });

  it('extra_invocation: adds unauthorized call to invocations', () => {
    const tx = fixtureTx(subscriptionJson);
    const originalCount = tx.invocations.length;
    const mutated = applyMutation(tx, {
      type: 'extra_invocation',
      contractId: 'CUNAUTHORIZED...',
      functionName: 'drain_funds',
    });

    expect(mutated.invocations).toHaveLength(originalCount + 1);
    expect(mutated.invocations[mutated.invocations.length - 1].functionName).toBe('drain_funds');
  });

  it('expired_rule: shifts timestamp far into the future', () => {
    const tx = fixtureTx(subscriptionJson);
    const mutated = applyMutation(tx, { type: 'expired_rule' });

    expect(mutated.timestamp).toBeGreaterThan(tx.timestamp + 365 * 24 * 3600);
  });

  it('wrong_function: replaces function name in first matching invocation', () => {
    const tx = fixtureTx(subscriptionJson);
    const contractId = tx.invocations[0].contractId;
    const mutated = applyMutation(tx, {
      type: 'wrong_function',
      contractId,
      functionName: 'withdraw',
    });

    expect(mutated.invocations[0].functionName).toBe('withdraw');
  });

  it('does not mutate original tx object (pure function)', () => {
    const tx = fixtureTx(subscriptionJson);
    const originalAmount = tx.assetTransfers[0].amount;
    applyMutation(tx, { type: 'exceed_spending', factor: 100 });

    // Original should be unchanged
    expect(tx.assetTransfers[0].amount).toBe(originalAmount);
  });
});

describe('generateDenyCases', () => {
  it('generates deny cases for spending limit policy', () => {
    const tx = fixtureTx(subscriptionJson);
    const generated = makeGeneratedCode();
    const cases = generateDenyCases([tx], generated);

    const exceedCase = cases.find((c) => c.id.includes('exceed-spend'));
    expect(exceedCase).toBeDefined();
  });

  it('generates wrong-function deny case for all scope entries', () => {
    const tx = fixtureTx(subscriptionJson);
    const generated = makeGeneratedCode();
    const cases = generateDenyCases([tx], generated);

    const wrongFnCase = cases.find((c) => c.id.includes('wrong-fn'));
    expect(wrongFnCase).toBeDefined();
    if (wrongFnCase) {
      expect(wrongFnCase.mutation.type).toBe('wrong_function');
    }
  });

  it('generates expired-rule deny case', () => {
    const tx = fixtureTx(subscriptionJson);
    const generated = makeGeneratedCode();
    const cases = generateDenyCases([tx], generated);

    const expiredCase = cases.find((c) => c.id.includes('expired'));
    expect(expiredCase).toBeDefined();
  });

  it('generates extra-invocation deny case', () => {
    const tx = fixtureTx(subscriptionJson);
    const generated = makeGeneratedCode();
    const cases = generateDenyCases([tx], generated);

    const extraCase = cases.find((c) => c.id.includes('extra-invocation'));
    expect(extraCase).toBeDefined();
  });

  it('generates at least 3 deny cases per tx', () => {
    const tx = fixtureTx(subscriptionJson);
    const generated = makeGeneratedCode();
    const cases = generateDenyCases([tx], generated);

    expect(cases.length).toBeGreaterThanOrEqual(3);
  });
});
