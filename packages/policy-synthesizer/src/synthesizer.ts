/**
 * Core synthesis engine.
 * Turns analyzed transaction facts into a PolicyProposal.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { RecordedTransaction } from '@oz-policy-builder/tx-recorder';
import { analyzeTransactions, derivePolicyHints } from './analyzer.js';
import { generateTimeBoundSource, generateCallFilterSource, generateFrequencyLimitSource, generateInstallScript } from './codegen.js';
import type {
  PolicyProposal,
  PolicySpec,
  ContextRuleSpec,
  LifetimeSpec,
  ClarifyingQuestion,
  ClarificationAnswer,
  GeneratedCode,
  SynthesisOptions,
  SpendingLimitConfig,
  CallFilterConfig,
  FrequencyLimitConfig,
  TimeBoundConfig,
  RustPolicySource,
  StandardPolicyInstallConfig,
} from './types.js';

const DEFAULT_LIFETIME_SECS = 365 * 24 * 3600; // 1 year
const DEFAULT_AGENT_LIFETIME_SECS = 90 * 24 * 3600; // 90 days for agent delegation

let anthropic: Anthropic | null = null;

function getAnthropic(apiKey?: string): Anthropic {
  if (!anthropic) {
    anthropic = new Anthropic({
      apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY,
    });
  }
  return anthropic;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Synthesize a PolicyProposal from one or more recorded transactions.
 */
export async function synthesizePolicy(
  txs: RecordedTransaction[],
  smartAccountId?: string,
  options: SynthesisOptions = {},
): Promise<PolicyProposal> {
  const proposalId = generateId();
  const facts = analyzeTransactions(txs, smartAccountId);
  const hints = derivePolicyHints(facts, smartAccountId);

  // Build context rule scope from facts
  const contextRule: ContextRuleSpec = {
    label: 'Generated Policy Rule',
    scope: facts.scope,
    lifetime: buildLifetimeSpec(options.defaultLifetimeSecs ?? DEFAULT_LIFETIME_SECS),
    rationale: buildScopeRationale(facts.scope, facts.txCount),
  };

  // Convert hints into policy specs
  const policies: PolicySpec[] = hints.map((hint) => hintToPolicy(hint));

  // Build clarifying questions for ambiguous parameters
  const questions = buildClarifyingQuestions(policies, facts, options.interactiveMode ?? true);

  // Use AI to enrich the rationale and check for missed constraints
  let synthesisNotes = '';
  if (options.anthropicApiKey || process.env.ANTHROPIC_API_KEY) {
    try {
      synthesisNotes = await enrichWithAI(txs, facts, policies, options);
    } catch (err) {
      synthesisNotes = `AI enrichment unavailable: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else {
    synthesisNotes = buildLocalSynthesisNotes(facts, policies);
  }

  return {
    proposalId,
    contextRule,
    policies,
    requiresCodeGeneration: policies.some((p) => !p.isStandardOz),
    questions,
    synthesisNotes,
  };
}

/**
 * Finalize a proposal after the user has answered clarifying questions.
 * Returns the generated code.
 */
export async function generateCode(
  proposal: PolicyProposal,
  answers: ClarificationAnswer[],
): Promise<GeneratedCode> {
  // Apply answers to the proposal
  const refined = applyAnswers(proposal, answers);

  const customPolicySources: RustPolicySource[] = [];
  const standardPolicyConfigs: StandardPolicyInstallConfig[] = [];

  for (const policy of refined.policies) {
    if (policy.isStandardOz) {
      standardPolicyConfigs.push({
        policyKind: policy.kind,
        ozContractName: ozContractName(policy.kind),
        config: policy.config,
      });
    } else {
      // Generate Rust source
      let source: RustPolicySource;
      switch (policy.kind) {
        case 'custom_time_bound':
          source = generateTimeBoundSource(policy);
          break;
        case 'custom_call_filter':
          source = generateCallFilterSource(policy);
          break;
        case 'custom_frequency_limit':
          source = generateFrequencyLimitSource(policy);
          break;
        default:
          // Should not happen with current policy kinds
          throw new Error(`Unknown custom policy kind: ${policy.kind}`);
      }
      customPolicySources.push(source);
    }
  }

  // Generate install script
  const lifetime = refined.contextRule.lifetime;
  const lifetimeSecs = lifetime.durationSeconds ?? DEFAULT_LIFETIME_SECS;
  const installScript = generateInstallScript(
    refined.contextRule.label,
    refined.contextRule.scope.map((s) => ({ contractId: s.contractId, functionName: s.functionName })),
    lifetimeSecs,
    standardPolicyConfigs.map((p) => ({ kind: p.policyKind, config: p.config as unknown })),
    [], // custom policy addresses filled after deployment
  );

  return {
    proposalId: proposal.proposalId,
    contextRuleConfig: {
      label: refined.contextRule.label,
      scope: refined.contextRule.scope,
      lifetime: refined.contextRule.lifetime,
      policyAddresses: [],
    },
    standardPolicyConfigs,
    customPolicySources,
    installScript,
    cargoToml: customPolicySources.length > 0 ? buildWorkspaceCargoToml(customPolicySources) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hintToPolicy(hint: ReturnType<typeof derivePolicyHints>[0]): PolicySpec {
  switch (hint.type) {
    case 'spending_limit':
      return {
        kind: 'oz_spending_limit',
        isStandardOz: true,
        label: `Spending Limit — ${hint.assetId}`,
        config: {
          kind: 'oz_spending_limit',
          assetContractId: hint.assetId,
          limitAmount: hint.amount,
          periodSeconds: hint.periodSeconds,
        } satisfies SpendingLimitConfig,
        rationale: `Cap outbound ${hint.assetId} transfers at ${hint.amount} per ${hint.periodSeconds / 3600}h period (observed max: ${hint.amount}).`,
      };

    case 'call_filter':
      return {
        kind: 'custom_call_filter',
        isStandardOz: false,
        label: `Call Filter — ${hint.functionName}`,
        contractName: 'policy_call_filter',
        config: {
          kind: 'custom_call_filter',
          allowedCalls: [
            {
              contractId: hint.contractId,
              functionName: hint.functionName,
              argConstraints: hint.recipientAddress
                ? [{ position: 1, requiredValue: hint.recipientAddress }]
                : [],
            },
          ],
        } satisfies CallFilterConfig,
        rationale: `Restrict calls to ${hint.contractId}::${hint.functionName}${hint.recipientAddress ? ` with recipient pinned to ${hint.recipientAddress}` : ''}.`,
      };

    case 'frequency_limit':
      return {
        kind: 'custom_frequency_limit',
        isStandardOz: false,
        label: `Frequency Limit — ${hint.maxCalls}/${hint.windowSeconds}s`,
        contractName: 'policy_frequency_limit',
        config: {
          kind: 'custom_frequency_limit',
          maxCallsPerWindow: hint.maxCalls,
          windowSeconds: hint.windowSeconds,
        } satisfies FrequencyLimitConfig,
        rationale: `Limit to ${hint.maxCalls} calls per ${hint.windowSeconds / 3600}h window.`,
      };

    case 'time_bound':
      return {
        kind: 'custom_time_bound',
        isStandardOz: false,
        label: `Time Bound — ledger ${hint.startLedger}–${hint.endLedger}`,
        contractName: 'policy_time_bound',
        config: {
          kind: 'custom_time_bound',
          startLedger: hint.startLedger,
          endLedger: hint.endLedger,
        } satisfies TimeBoundConfig,
        rationale: `Restrict invocations to ledger sequence ${hint.startLedger}–${hint.endLedger}.`,
      };
  }
}

function buildLifetimeSpec(durationSecs: number): LifetimeSpec {
  return {
    type: 'duration_seconds',
    durationSeconds: durationSecs,
    description: `${Math.round(durationSecs / 86400)} days from installation`,
  };
}

function buildScopeRationale(scope: Array<{ contractId: string; functionName: string }>, txCount: number): string {
  return (
    `Scope derived from ${txCount} observed transaction(s). ` +
    `Exactly ${scope.length} unique (contract, function) pair(s) were called: ` +
    scope.map((s) => `${s.contractId.slice(0, 8)}...::${s.functionName}`).join(', ') +
    '. No additional calls are permitted.'
  );
}

function buildClarifyingQuestions(
  policies: PolicySpec[],
  facts: ReturnType<typeof analyzeTransactions>,
  interactive: boolean,
): ClarifyingQuestion[] {
  if (!interactive) return [];

  const questions: ClarifyingQuestion[] = [];
  let qIdx = 0;

  // Encode policyIdx in the question ID so applyAnswers can apply each answer to the
  // correct policy instance (prevents cross-contamination when multiple spending limits exist)
  policies.forEach((policy, policyIdx) => {
    if (policy.kind === 'oz_spending_limit') {
      const config = policy.config as SpendingLimitConfig;
      questions.push({
        id: `q${qIdx++}_sl${policyIdx}`,
        text: `Observed max transfer: ${config.limitAmount} ${config.assetContractId.slice(0, 8)}.... Should the spending cap be exactly ${config.limitAmount} (tight), or a higher budget (specify)?`,
        options: [
          `${config.limitAmount} (exact — observed max)`,
          `${config.limitAmount * 2n} (2× observed)`,
          `${config.limitAmount * 10n} (10× observed)`,
          'Custom amount',
        ],
        defaultAnswer: `${config.limitAmount} (exact — observed max)`,
        impactsPolicy: policy.kind,
      });

      questions.push({
        id: `q${qIdx++}_slp${policyIdx}`,
        text: `What should the spending limit period be? (Currently: ${config.periodSeconds / 3600}h)`,
        options: ['1 hour', '24 hours', '7 days', '30 days'],
        defaultAnswer: '24 hours',
        impactsPolicy: policy.kind,
      });
    }

    if (policy.kind === 'custom_time_bound' || policy.kind === 'oz_spending_limit') {
      questions.push({
        id: `q${qIdx++}_lt`,
        text: `How long should this context rule be valid? (Current default: 90 days for agent delegation, 1 year for subscriptions)`,
        options: ['7 days', '30 days', '90 days', '1 year'],
        defaultAnswer: '90 days',
        impactsPolicy: 'context_rule_lifetime',
      });
    }
  });

  return questions;
}

function applyAnswers(proposal: PolicyProposal, answers: ClarificationAnswer[]): PolicyProposal {
  // Deep clone with BigInt support — JSON.parse/stringify drops bigint values by default
  const refined = deepCloneWithBigInt(proposal) as PolicyProposal;

  for (const answer of answers) {
    // Lifetime override — question IDs ending in _lt, or fallback: answer contains time words
    if (answer.questionId.endsWith('_lt') ||
        (!answer.questionId.includes('_sl') && (answer.answer.includes('days') || answer.answer.includes('year')))) {
      const days = parseLifetimeDays(answer.answer);
      if (days > 0) {
        refined.contextRule.lifetime = {
          type: 'duration_seconds',
          durationSeconds: days * 86400,
          description: `${days} days from installation`,
        };
      }
    }

    // Spending limit amount override — _sl{policyIdx} suffix targets the specific policy
    const slMatch = answer.questionId.match(/_sl(\d+)$/);
    if (slMatch) {
      const pIdx = parseInt(slMatch[1], 10);
      const policy = refined.policies[pIdx];
      if (policy?.kind === 'oz_spending_limit') {
        const config = policy.config as SpendingLimitConfig;
        const match = answer.answer.match(/^(\d+)/);
        if (match) {
          config.limitAmount = BigInt(match[1]);
        }
      }
    }
  }

  return refined;
}

/** Deep clone preserving BigInt values via a replacer/reviver pair. */
function deepCloneWithBigInt<T>(obj: T): T {
  return JSON.parse(
    JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? { __bigint__: v.toString() } : v)),
    (_, v) => (v && typeof v === 'object' && '__bigint__' in v ? BigInt((v as { __bigint__: string }).__bigint__) : v),
  ) as T;
}

function parseLifetimeDays(answer: string): number {
  if (answer.includes('7 day')) return 7;
  if (answer.includes('30 day')) return 30;
  if (answer.includes('90 day')) return 90;
  if (answer.includes('1 year') || answer.includes('365')) return 365;
  const match = answer.match(/(\d+)\s*day/);
  return match ? parseInt(match[1]) : 0;
}

function ozContractName(kind: string): string {
  const map: Record<string, string> = {
    oz_spending_limit: 'SpendingLimitPolicy',
    oz_simple_threshold: 'SimpleThresholdPolicy',
    oz_weighted_threshold: 'WeightedThresholdPolicy',
  };
  return map[kind] ?? kind;
}

function buildWorkspaceCargoToml(sources: RustPolicySource[]): string {
  return `[workspace]
members = [
${sources.map((s) => `  "${s.contractName}",`).join('\n')}
]
resolver = "2"

[workspace.dependencies]
soroban-sdk = { version = "22.0.1", features = [] }
oz-policy-trait = { git = "https://github.com/oz-policy-builder/oz-policy-builder", tag = "v0.1.0" }

[profile.release]
opt-level = "z"
overflow-checks = true
debug = 0
strip = "symbols"
debug-assertions = false
panic = "abort"
codegen-units = 1
lto = true
`;
}

function buildLocalSynthesisNotes(
  facts: ReturnType<typeof analyzeTransactions>,
  policies: PolicySpec[],
): string {
  const lines = [
    `Analyzed ${facts.txCount} transaction(s).`,
    `Observed ${facts.scope.length} unique contract call(s).`,
    `Generated ${policies.filter((p) => p.isStandardOz).length} OZ standard policy configuration(s) and ${policies.filter((p) => !p.isStandardOz).length} custom policy contract(s).`,
    '',
    'Scope is the minimal set of (contract, function) pairs observed — no extras.',
    'Spending caps default to the observed maximum transfer amount. Adjust using clarifying questions.',
  ];
  return lines.join('\n');
}

async function enrichWithAI(
  txs: RecordedTransaction[],
  facts: ReturnType<typeof analyzeTransactions>,
  policies: PolicySpec[],
  options: SynthesisOptions,
): Promise<string> {
  const client = getAnthropic(options.anthropicApiKey);
  const model = options.model ?? 'claude-sonnet-4-6';

  const txSummary = txs.map((tx) => ({
    hash: tx.hash,
    invocations: tx.invocations.map((inv) => ({
      contract: inv.contractId,
      function: inv.functionName,
      argCount: inv.args.length,
    })),
    transfers: tx.assetTransfers.map((t) => ({
      asset: t.assetCode,
      amount: t.amount.toString(),
      from: t.from.slice(0, 10) + '...',
      to: t.to.slice(0, 10) + '...',
    })),
  }));

  const msg = await client.messages.create({
    model,
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `You are a Stellar smart account security expert reviewing a synthesized policy proposal.

Transaction summary (${txs.length} tx(s)):
${JSON.stringify(txSummary, null, 2)}

Proposed policies:
${policies.map((p) => `- ${p.label}: ${p.rationale}`).join('\n')}

Please provide:
1. A brief assessment of whether the proposed policies are sufficient and minimal.
2. Any constraints that may have been missed.
3. Any security concerns with the generated policy.
4. Suggested clarifying questions not already in the list.

Keep the response under 300 words. Be concrete and specific to Stellar/Soroban.`,
      },
    ],
  });

  const content = msg.content[0];
  return content.type === 'text' ? content.text : '';
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
