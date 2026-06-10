import type { RecordedTransaction } from '@oz-policy-builder/tx-recorder';
import type { GeneratedCode } from '@oz-policy-builder/policy-synthesizer';

export type Network = 'mainnet' | 'testnet' | 'futurenet';

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

/** A test case that should be PERMITTED by the policy. */
export interface PermitCase {
  id: string;
  description: string;
  /** A recorded tx that the policy should allow. Usually the original. */
  tx: RecordedTransaction;
}

/** A test case that should be DENIED by the policy. */
export interface DenyCase {
  id: string;
  description: string;
  /** Base tx to mutate. */
  baseTx: RecordedTransaction;
  /** Mutation to apply before simulating. */
  mutation: DenyMutation;
}

export type DenyMutation =
  | { type: 'exceed_spending'; factor: number }         // amount * factor
  | { type: 'wrong_asset'; substituteAssetId: string }  // different SAC
  | { type: 'out_of_window'; ledgerOffset: number }     // ledger offset outside valid range
  | { type: 'extra_invocation'; contractId: string; functionName: string } // add unauthorized call
  | { type: 'expired_rule' }                            // set lifetime to past
  | { type: 'wrong_function'; contractId: string; functionName: string }  // call unlisted fn
  | { type: 'exceed_frequency'; callCount: number };    // call more times than allowed

// ---------------------------------------------------------------------------
// Simulation result
// ---------------------------------------------------------------------------

export interface CaseResult {
  caseId: string;
  caseType: 'permit' | 'deny';
  description: string;
  /** Expected outcome. */
  expected: 'permit' | 'deny';
  /** Actual outcome from simulation. */
  actual: 'permit' | 'deny' | 'error';
  /** Whether the test passed (actual matches expected). */
  passed: boolean;
  /** True when the case was skipped (e.g. simulation-mode tx with no real envelope). Skipped cases are excluded from coverageScore. */
  skipped?: boolean;
  /** Error message if actual === 'error'. */
  errorMessage?: string;
  /** Simulation response details. */
  simulationDetail?: unknown;
}

export interface SimulationReport {
  proposalId: string;
  network: Network;
  timestamp: number;
  permitResults: CaseResult[];
  denyResults: CaseResult[];
  /** 0–1 score: fraction of cases that passed. */
  coverageScore: number;
  /** Human-readable summary. */
  summary: string;
  /** Issues found. */
  issues: SimulationIssue[];
}

export interface SimulationIssue {
  severity: 'error' | 'warning' | 'info';
  caseId: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Harness options
// ---------------------------------------------------------------------------

export interface HarnessOptions {
  network: Network;
  /** Soroban RPC URL override. */
  rpcUrl?: string;
  /** Deployed policy contract addresses (for live simulation). */
  deployedPolicyAddresses?: string[];
  /** Smart account address under test. */
  smartAccountId?: string;
  /** If true, use dry-run mode (no on-chain state changes). Default: true. */
  dryRun?: boolean;
}
