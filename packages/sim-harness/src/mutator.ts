/**
 * Deny-case mutation engine.
 * Takes a permit case and applies mutations to produce deny cases.
 */

import type { RecordedTransaction, Invocation, AssetTransfer } from '@oz-policy-builder/tx-recorder';
import type { DenyMutation, DenyCase } from './types.js';
import type { GeneratedCode } from '@oz-policy-builder/policy-synthesizer';

/**
 * Auto-generate deny cases from the permit cases and the generated policy code.
 */
export function generateDenyCases(
  permitCases: RecordedTransaction[],
  generatedCode: GeneratedCode,
): DenyCase[] {
  const cases: DenyCase[] = [];
  let idx = 0;

  for (const tx of permitCases) {
    // 1. Exceed spending for each asset
    for (const policy of generatedCode.standardPolicyConfigs) {
      if (policy.policyKind === 'oz_spending_limit') {
        const config = policy.config as { assetContractId: string; limitAmount: bigint };
        cases.push({
          id: `deny-exceed-spend-${idx++}`,
          description: `Exceed spending limit for ${config.assetContractId}: amount × 10`,
          baseTx: tx,
          mutation: { type: 'exceed_spending', factor: 10 },
        });
      }
    }

    // 2. Call unlisted function (add a swap call that's not in scope)
    const scope = generatedCode.contextRuleConfig.scope;
    if (scope.length > 0) {
      const firstCall = scope[0];
      cases.push({
        id: `deny-wrong-fn-${idx++}`,
        description: `Call a function not in scope: ${firstCall.contractId}::withdraw`,
        baseTx: tx,
        mutation: {
          type: 'wrong_function',
          contractId: firstCall.contractId,
          functionName: 'withdraw',
        },
      });
    }

    // 3. Expired context rule
    cases.push({
      id: `deny-expired-${idx++}`,
      description: 'Context rule expired (lifetime in the past)',
      baseTx: tx,
      mutation: { type: 'expired_rule' },
    });

    // 4. Extra unauthorized invocation
    cases.push({
      id: `deny-extra-invocation-${idx++}`,
      description: 'Add unauthorized contract call alongside permitted call',
      baseTx: tx,
      mutation: {
        type: 'extra_invocation',
        contractId: 'CUNAUTHORIZED0000000000000000000000000000000000000000', // dummy
        functionName: 'drain_funds',
      },
    });
  }

  return cases;
}

/**
 * Apply a mutation to a recorded transaction to produce a deny-case tx.
 */
export function applyMutation(
  tx: RecordedTransaction,
  mutation: DenyMutation,
): RecordedTransaction {
  const mutated = deepClone(tx);

  switch (mutation.type) {
    case 'exceed_spending': {
      // Multiply all transfer amounts by the factor
      for (const transfer of mutated.assetTransfers) {
        transfer.amount = transfer.amount * BigInt(Math.round(mutation.factor));
      }
      // Also mutate args in invocations
      mutateTransferAmounts(mutated.invocations, BigInt(Math.round(mutation.factor)));
      break;
    }

    case 'wrong_asset': {
      // Replace asset IDs in transfers
      for (const transfer of mutated.assetTransfers) {
        transfer.assetCode = mutation.substituteAssetId;
      }
      // Replace contract addresses in transfer invocations
      for (const inv of mutated.invocations) {
        substituteContractId(inv, mutation.substituteAssetId);
      }
      break;
    }

    case 'out_of_window': {
      // Shift timestamp to outside valid window
      mutated.timestamp += mutation.ledgerOffset;
      mutated.ledger += Math.abs(mutation.ledgerOffset);
      break;
    }

    case 'extra_invocation': {
      // Add an unauthorized top-level invocation
      mutated.invocations.push({
        contractId: mutation.contractId,
        functionName: mutation.functionName,
        args: [],
        subInvocations: [],
        success: true,
      });
      break;
    }

    case 'expired_rule': {
      // Shift timestamp far into the future (past any lifetime)
      mutated.timestamp += 365 * 24 * 3600 * 10; // 10 years ahead
      mutated.ledger += 1_000_000;
      break;
    }

    case 'wrong_function': {
      // Replace function name in the first matching invocation
      for (const inv of mutated.invocations) {
        if (inv.contractId === mutation.contractId) {
          inv.functionName = mutation.functionName;
          break;
        }
        for (const sub of inv.subInvocations) {
          if (sub.contractId === mutation.contractId) {
            sub.functionName = mutation.functionName;
            break;
          }
        }
      }
      break;
    }

    case 'exceed_frequency': {
      // Add duplicate invocations
      const original = [...mutated.invocations];
      for (let i = 0; i < mutation.callCount - 1; i++) {
        mutated.invocations.push(...deepClone(original));
      }
      break;
    }
  }

  return mutated;
}

function mutateTransferAmounts(invocations: Invocation[], factor: bigint): void {
  for (const inv of invocations) {
    const fn = inv.functionName.toLowerCase();
    if (fn === 'transfer' || fn === 'transfer_from') {
      const amountIdx = fn === 'transfer' ? 2 : 3;
      const arg = inv.args[amountIdx];
      if (arg && typeof arg.value === 'bigint') {
        arg.value = arg.value * factor;
      }
    }
    mutateTransferAmounts(inv.subInvocations, factor);
  }
}

function substituteContractId(inv: Invocation, newContractId: string): void {
  const fn = inv.functionName.toLowerCase();
  if (fn === 'transfer' || fn === 'transfer_from') {
    inv.contractId = newContractId;
  }
  for (const sub of inv.subInvocations) {
    substituteContractId(sub, newContractId);
  }
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj, (_, v) =>
    typeof v === 'bigint' ? { __bigint__: v.toString() } : v,
  ), (_, v) =>
    v && typeof v === 'object' && '__bigint__' in v ? BigInt(v.__bigint__) : v,
  ) as T;
}
