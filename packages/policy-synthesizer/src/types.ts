// Policy Synthesizer types

import type { RecordedTransaction } from '@oz-policy-builder/tx-recorder';

// ---------------------------------------------------------------------------
// Context Rule Specification
// ---------------------------------------------------------------------------

export interface ContextRuleSpec {
  /** Human-readable label. */
  label: string;
  /** Exact set of (contractId, functionName) pairs allowed. */
  scope: ScopeEntry[];
  /** Lifetime bounds. */
  lifetime: LifetimeSpec;
  /** Rationale for the scope choices. */
  rationale: string;
}

export interface ScopeEntry {
  contractId: string;
  contractName?: string;
  functionName: string;
}

export interface LifetimeSpec {
  /** Lifetime type. */
  type: 'ledger_range' | 'duration_seconds';
  /** Start ledger (for ledger_range). */
  startLedger?: number;
  /** End ledger (for ledger_range). */
  endLedger?: number;
  /** Duration in seconds from now (for duration_seconds). */
  durationSeconds?: number;
  /** Human-readable description. */
  description: string;
}

// ---------------------------------------------------------------------------
// Policy Specification
// ---------------------------------------------------------------------------

export type PolicyKind =
  | 'oz_spending_limit'
  | 'oz_simple_threshold'
  | 'oz_weighted_threshold'
  | 'custom_time_bound'
  | 'custom_call_filter'
  | 'custom_frequency_limit'
  | 'custom_composite';

export interface PolicySpec {
  kind: PolicyKind;
  /** Whether this is a standard OZ policy (configure only) or needs code generation. */
  isStandardOz: boolean;
  /** Human-readable label. */
  label: string;
  /** Configuration parameters for this policy. */
  config: PolicyConfig;
  /** Generated Rust source (only for custom policies). */
  generatedSource?: string;
  /** The contract name to use for the generated policy. */
  contractName?: string;
  /** Rationale for including this policy. */
  rationale: string;
}

export type PolicyConfig =
  | SpendingLimitConfig
  | SimpleThresholdConfig
  | WeightedThresholdConfig
  | TimeBoundConfig
  | CallFilterConfig
  | FrequencyLimitConfig
  | CompositeConfig;

export interface SpendingLimitConfig {
  kind: 'oz_spending_limit';
  assetContractId: string;
  limitAmount: bigint;
  periodSeconds: number;
}

export interface SimpleThresholdConfig {
  kind: 'oz_simple_threshold';
  threshold: number;
}

export interface WeightedThresholdConfig {
  kind: 'oz_weighted_threshold';
  signers: Array<{ address: string; weight: number }>;
  threshold: number;
}

export interface TimeBoundConfig {
  kind: 'custom_time_bound';
  startLedger: number;
  endLedger: number;
}

export interface CallFilterConfig {
  kind: 'custom_call_filter';
  allowedCalls: Array<{
    contractId: string;
    functionName: string;
    argConstraints?: Array<{ position: number; requiredValue: unknown }>;
  }>;
}

export interface FrequencyLimitConfig {
  kind: 'custom_frequency_limit';
  maxCallsPerWindow: number;
  windowSeconds: number;
}

export interface CompositeConfig {
  kind: 'custom_composite';
  subPolicies: string[]; // contract addresses of deployed sub-policies
}

// ---------------------------------------------------------------------------
// Policy Proposal (output of synthesize)
// ---------------------------------------------------------------------------

export interface PolicyProposal {
  /** Unique ID for this proposal (session reference). */
  proposalId: string;
  /** The synthesized context rule. */
  contextRule: ContextRuleSpec;
  /** The policies to attach to this rule. */
  policies: PolicySpec[];
  /** Whether to generate any custom Rust contracts. */
  requiresCodeGeneration: boolean;
  /** Clarifying questions the user should answer before finalizing. */
  questions: ClarifyingQuestion[];
  /** Summary of what was observed and what was inferred. */
  synthesisNotes: string;
}

export interface ClarifyingQuestion {
  id: string;
  text: string;
  options?: string[];
  defaultAnswer?: string;
  impactsPolicy: string; // which policy spec this question affects
}

// ---------------------------------------------------------------------------
// Generated Code Output
// ---------------------------------------------------------------------------

export interface GeneratedCode {
  proposalId: string;
  /** JSON config for the install transaction. */
  contextRuleConfig: ContextRuleInstallConfig;
  /** Standard OZ policy configurations (no compilation needed). */
  standardPolicyConfigs: StandardPolicyInstallConfig[];
  /** Custom Rust policy source files. */
  customPolicySources: RustPolicySource[];
  /** TypeScript install helper script. */
  installScript: string;
  /** Cargo.toml for custom policies if any. */
  cargoToml?: string;
}

export interface ContextRuleInstallConfig {
  label: string;
  scope: ScopeEntry[];
  lifetime: LifetimeSpec;
  policyAddresses: string[]; // filled after deployment
}

export interface StandardPolicyInstallConfig {
  policyKind: string;
  ozContractName: string;
  config: PolicyConfig;
}

export interface RustPolicySource {
  contractName: string;
  filename: string;
  source: string;
  cargoToml: string;
}

// ---------------------------------------------------------------------------
// Synthesis options
// ---------------------------------------------------------------------------

export interface SynthesisOptions {
  /** Claude API key. */
  anthropicApiKey?: string;
  /** Default lifetime duration in seconds. */
  defaultLifetimeSecs?: number;
  /** If true, ask clarifying questions. If false, use defaults. */
  interactiveMode?: boolean;
  /** Model to use for AI-assisted synthesis. */
  model?: string;
}

export interface ClarificationAnswer {
  questionId: string;
  answer: string;
}
