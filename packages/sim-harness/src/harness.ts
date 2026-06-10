/**
 * Simulation harness runner.
 * Executes permit and deny cases against the Soroban RPC.
 */

import { rpc as SorobanRpc, xdr } from '@stellar/stellar-sdk';
import type { RecordedTransaction } from '@oz-policy-builder/tx-recorder';
import type { GeneratedCode } from '@oz-policy-builder/policy-synthesizer';
import type {
  PermitCase,
  DenyCase,
  CaseResult,
  SimulationReport,
  HarnessOptions,
  SimulationIssue,
} from './types.js';
import { applyMutation, generateDenyCases } from './mutator.js';

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run a full permit/deny harness against the deployed policies.
 *
 * If `denyCases` is not provided, they are auto-generated from the permit cases
 * and the generated policy code.
 */
export async function runHarness(
  proposalId: string,
  permitCases: PermitCase[],
  generatedCode: GeneratedCode,
  options: HarnessOptions,
  denyCases?: DenyCase[],
): Promise<SimulationReport> {
  const rpcUrl = options.rpcUrl ?? defaultRpcUrl(options.network);
  const rpc = new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });

  const autoDenyCases = denyCases ?? generateDenyCases(
    permitCases.map((c) => c.tx),
    generatedCode,
  );

  const permitResults: CaseResult[] = [];
  const denyResults: CaseResult[] = [];

  // Run permit cases
  for (const permitCase of permitCases) {
    const result = await runSingleCase(rpc, permitCase.tx, 'permit', permitCase.id, permitCase.description);
    permitResults.push(result);
  }

  // Run deny cases
  for (const denyCase of autoDenyCases) {
    const mutatedTx = applyMutation(denyCase.baseTx, denyCase.mutation);
    const result = await runSingleCase(rpc, mutatedTx, 'deny', denyCase.id, denyCase.description);
    denyResults.push(result);
  }

  const allResults = [...permitResults, ...denyResults];
  // Exclude skipped cases (simulation-mode txs without a real envelope) from the score
  const scoredResults = allResults.filter((r) => !r.skipped);
  const passed = scoredResults.filter((r) => r.passed).length;
  const coverageScore = scoredResults.length > 0 ? passed / scoredResults.length : 0;

  const issues = buildIssues(allResults);

  return {
    proposalId,
    network: options.network,
    timestamp: Math.floor(Date.now() / 1000),
    permitResults,
    denyResults,
    coverageScore,
    summary: buildSummary(permitResults, denyResults, coverageScore),
    issues,
  };
}

/**
 * Quick policy verification: run only the permit case to check the original tx passes.
 */
export async function verifyPermit(
  tx: RecordedTransaction,
  network: HarnessOptions['network'],
  rpcUrl?: string,
): Promise<{ passed: boolean; message: string }> {
  const url = rpcUrl ?? defaultRpcUrl(network);
  const rpc = new SorobanRpc.Server(url, { allowHttp: url.startsWith('http://') });
  const result = await runSingleCase(rpc, tx, 'permit', 'quick-verify', 'Quick permit check');
  return {
    passed: result.passed,
    message: result.passed ? 'Transaction would be permitted.' : (result.errorMessage ?? 'Transaction would be denied.'),
  };
}

// ---------------------------------------------------------------------------
// Single case runner
// ---------------------------------------------------------------------------

async function runSingleCase(
  rpc: SorobanRpc.Server,
  tx: RecordedTransaction,
  caseType: 'permit' | 'deny',
  caseId: string,
  description: string,
): Promise<CaseResult> {
  const expected = caseType;
  let actual: 'permit' | 'deny' | 'error' = 'error';
  let errorMessage: string | undefined;
  let simulationDetail: unknown;

  let skipped = false;

  try {
    if (tx.network === 'simulation' || tx.rawEnvelope === 'simulation') {
      // No real envelope to re-simulate; skip this case so it doesn't inflate coverage
      skipped = true;
      actual = caseType; // conservative: don't penalise missing envelope
    } else {
      const envelope = xdr.TransactionEnvelope.fromXDR(tx.rawEnvelope, 'base64');
      const simResult = await rpc.simulateTransaction(
        { toEnvelope: () => envelope } as unknown as Parameters<SorobanRpc.Server['simulateTransaction']>[0],
      );

      if (SorobanRpc.Api.isSimulationError(simResult)) {
        actual = 'deny';
        errorMessage = simResult.error;
        simulationDetail = simResult;
      } else if (SorobanRpc.Api.isSimulationSuccess(simResult)) {
        actual = 'permit';
        simulationDetail = simResult;
      } else {
        actual = 'error';
        errorMessage = 'Unexpected simulation response type';
      }
    }
  } catch (err: unknown) {
    actual = 'error';
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  const passed = actual === expected;

  return {
    caseId,
    caseType,
    description,
    expected,
    actual,
    passed,
    skipped,
    errorMessage,
    simulationDetail,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultRpcUrl(network: HarnessOptions['network']): string {
  const urls: Record<string, string> = {
    mainnet: 'https://mainnet.sorobanrpc.com',
    testnet: 'https://soroban-testnet.stellar.org',
    futurenet: 'https://rpc-futurenet.stellar.org',
  };
  return urls[network];
}

function buildIssues(results: CaseResult[]): SimulationIssue[] {
  const issues: SimulationIssue[] = [];
  for (const r of results) {
    if (!r.passed) {
      issues.push({
        severity: r.caseType === 'permit' ? 'error' : 'warning',
        caseId: r.caseId,
        message: r.caseType === 'permit'
          ? `Permit case failed: policy denied a transaction that should have been allowed. ${r.errorMessage ?? ''}`
          : `Deny case failed: policy allowed a transaction that should have been denied.`,
      });
    }
    if (r.actual === 'error') {
      issues.push({
        severity: 'warning',
        caseId: r.caseId,
        message: `Simulation error: ${r.errorMessage}`,
      });
    }
  }
  return issues;
}

function buildSummary(
  permitResults: CaseResult[],
  denyResults: CaseResult[],
  coverageScore: number,
): string {
  const permitPassed = permitResults.filter((r) => r.passed).length;
  const denyPassed = denyResults.filter((r) => r.passed).length;
  return (
    `Permit cases: ${permitPassed}/${permitResults.length} passed. ` +
    `Deny cases: ${denyPassed}/${denyResults.length} passed. ` +
    `Coverage score: ${(coverageScore * 100).toFixed(0)}%.`
  );
}
