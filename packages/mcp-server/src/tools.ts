/**
 * MCP tool definitions and handlers.
 *
 * Each tool follows the pattern:
 *   - input_schema: JSON Schema for validation
 *   - handler: async function returning { ok, data } | { ok, error }
 */

import { recordFromHash, recordFromXdr, type Network } from '@oz-policy-builder/tx-recorder';
import { synthesizePolicy, generateCode } from '@oz-policy-builder/policy-synthesizer';
import type { ClarificationAnswer } from '@oz-policy-builder/policy-synthesizer';
import { runHarness } from '@oz-policy-builder/sim-harness';
import {
  createSession,
  requireSession,
  type Session,
} from './session.js';

// ---------------------------------------------------------------------------
// Tool: record_transaction
// ---------------------------------------------------------------------------

export const recordTransactionTool = {
  name: 'record_transaction',
  description:
    'Record a Stellar transaction by hash or XDR envelope. Returns a session ID and a structured view of all contract invocations and asset transfers. Use this as the first step before synthesizing a policy.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      tx_hash: {
        type: 'string',
        description: 'Transaction hash (64 hex chars). Provide either this or tx_xdr.',
      },
      tx_xdr: {
        type: 'string',
        description: 'Base64-encoded XDR transaction envelope. Provide either this or tx_hash.',
      },
      network: {
        type: 'string',
        enum: ['mainnet', 'testnet', 'futurenet'],
        description: 'Stellar network to use. Default: testnet.',
      },
      session_id: {
        type: 'string',
        description: 'Existing session ID to add this transaction to. If omitted, a new session is created.',
      },
    },
    required: [],
  },
};

export async function handleRecordTransaction(input: Record<string, unknown>): Promise<unknown> {
  const { tx_hash, tx_xdr, session_id } = input as {
    tx_hash?: string;
    tx_xdr?: string;
    session_id?: string;
  };

  let network: Network;
  try {
    network = validateNetwork(input.network ?? 'testnet');
  } catch (err) {
    return errorResponse('INVALID_INPUT', err instanceof Error ? err.message : String(err));
  }

  if (!tx_hash && !tx_xdr) {
    return errorResponse('MISSING_INPUT', 'Provide either tx_hash or tx_xdr.');
  }

  let session: Session;
  if (session_id) {
    const maybeSession = safeRequireSession(session_id);
    if (isErrorResult(maybeSession)) return maybeSession;
    session = maybeSession as Session;
  } else {
    session = createSession();
  }

  try {
    const tx = tx_hash
      ? await recordFromHash(tx_hash, network ?? 'testnet')
      : await recordFromXdr(tx_xdr!, network ?? 'testnet');

    session.recordedTxs.push(tx);

    return {
      ok: true,
      data: {
        session_id: session.id,
        tx_hash: tx.hash,
        network: tx.network,
        ledger: tx.ledger,
        invocation_count: tx.invocations.length,
        transfer_count: tx.assetTransfers.length,
        invocations: tx.invocations.map((inv) => ({
          contract: inv.contractId,
          function: inv.functionName,
          arg_count: inv.args.length,
          sub_invocations: inv.subInvocations.length,
        })),
        asset_transfers: tx.assetTransfers.map((t) => ({
          asset: t.assetCode,
          from: t.from,
          to: t.to,
          amount: t.amount.toString(),
        })),
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse('RECORD_ERROR', message, { tx_hash, tx_xdr, network });
  }
}

// ---------------------------------------------------------------------------
// Tool: list_invocations
// ---------------------------------------------------------------------------

export const listInvocationsTool = {
  name: 'list_invocations',
  description: 'List all contract invocations from transactions recorded in the current session.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      session_id: { type: 'string', description: 'Session ID from record_transaction.' },
    },
    required: ['session_id'],
  },
};

export function handleListInvocations(input: Record<string, unknown>): unknown {
  const maybeSession = safeRequireSession(input.session_id as string);
  if (isErrorResult(maybeSession)) return maybeSession;
  const session = maybeSession as Session;
  const allInvocations = session.recordedTxs.flatMap((tx) =>
    tx.invocations.map((inv) => ({
      tx_hash: tx.hash,
      contract_id: inv.contractId,
      contract_name: inv.contractName,
      function_name: inv.functionName,
      args: inv.args.map((a) => ({ type: a.type, value: String(a.value) })),
    })),
  );
  return {
    ok: true,
    data: {
      session_id: session.id,
      tx_count: session.recordedTxs.length,
      total_invocations: allInvocations.length,
      invocations: allInvocations,
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: synthesize_policy
// ---------------------------------------------------------------------------

export const synthesizePolicyTool = {
  name: 'synthesize_policy',
  description:
    'Synthesize a context rule and policy set from the recorded transactions. Returns a policy proposal with clarifying questions that may need answers before generating code.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      session_id: { type: 'string', description: 'Session ID from record_transaction.' },
      smart_account_id: {
        type: 'string',
        description: 'Smart account address (C-address) being delegated from. Used to determine transfer direction.',
      },
      interactive: {
        type: 'boolean',
        description: 'If true (default), return clarifying questions. If false, use defaults.',
      },
    },
    required: ['session_id'],
  },
};

export async function handleSynthesizePolicy(input: Record<string, unknown>): Promise<unknown> {
  const maybeSession = safeRequireSession(input.session_id as string);
  if (isErrorResult(maybeSession)) return maybeSession;
  const session = maybeSession as Session;

  if (session.recordedTxs.length === 0) {
    return errorResponse('NO_TRANSACTIONS', 'Record at least one transaction first.');
  }

  try {
    const proposal = await synthesizePolicy(
      session.recordedTxs,
      input.smart_account_id as string | undefined,
      {
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        interactiveMode: (input.interactive as boolean) ?? true,
      },
    );

    session.proposal = proposal;

    return {
      ok: true,
      data: {
        session_id: session.id,
        proposal_id: proposal.proposalId,
        context_rule: {
          label: proposal.contextRule.label,
          scope: proposal.contextRule.scope,
          lifetime: proposal.contextRule.lifetime,
          rationale: proposal.contextRule.rationale,
        },
        policies: proposal.policies.map((p) => ({
          kind: p.kind,
          label: p.label,
          is_standard_oz: p.isStandardOz,
          rationale: p.rationale,
        })),
        requires_code_generation: proposal.requiresCodeGeneration,
        synthesis_notes: proposal.synthesisNotes,
      },
      questions: proposal.questions.map((q) => ({
        id: q.id,
        text: q.text,
        options: q.options,
        default_answer: q.defaultAnswer,
        impacts_policy: q.impactsPolicy,
      })),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse('SYNTHESIS_ERROR', message);
  }
}

// ---------------------------------------------------------------------------
// Tool: answer_clarification
// ---------------------------------------------------------------------------

export const answerClarificationTool = {
  name: 'answer_clarification',
  description: 'Provide answers to clarifying questions returned by synthesize_policy.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      session_id: { type: 'string' },
      answers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question_id: { type: 'string' },
            answer: { type: 'string' },
          },
          required: ['question_id', 'answer'],
        },
        description: 'Array of {question_id, answer} pairs.',
      },
    },
    required: ['session_id', 'answers'],
  },
};

export function handleAnswerClarification(input: Record<string, unknown>): unknown {
  const maybeSession = safeRequireSession(input.session_id as string);
  if (isErrorResult(maybeSession)) return maybeSession;
  const session = maybeSession as Session;
  const answers = input.answers as Array<{ question_id: string; answer: string }>;

  for (const answer of answers) {
    session.clarifications.set(answer.question_id, answer.answer);
  }

  return {
    ok: true,
    data: {
      session_id: session.id,
      answered: answers.length,
      total_clarifications: session.clarifications.size,
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: generate_code
// ---------------------------------------------------------------------------

export const generateCodeTool = {
  name: 'generate_code',
  description:
    'Generate Rust policy contracts and an install script from the synthesized proposal. Call synthesize_policy (and optionally answer_clarification) first.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      session_id: { type: 'string' },
    },
    required: ['session_id'],
  },
};

export async function handleGenerateCode(input: Record<string, unknown>): Promise<unknown> {
  const maybeSession = safeRequireSession(input.session_id as string);
  if (isErrorResult(maybeSession)) return maybeSession;
  const session = maybeSession as Session;

  if (!session.proposal) {
    return errorResponse('NO_PROPOSAL', 'Run synthesize_policy first.');
  }

  const answers: ClarificationAnswer[] = Array.from(session.clarifications.entries()).map(
    ([questionId, answer]) => ({ questionId, answer }),
  );

  try {
    const generated = await generateCode(session.proposal, answers);
    session.generatedCode = generated;

    return {
      ok: true,
      data: {
        session_id: session.id,
        proposal_id: generated.proposalId,
        requires_compilation: generated.customPolicySources.length > 0,
        standard_policy_count: generated.standardPolicyConfigs.length,
        custom_policy_count: generated.customPolicySources.length,
        custom_policy_sources: generated.customPolicySources.map((s) => ({
          contract_name: s.contractName,
          filename: s.filename,
          source_length: s.source.length,
          source: s.source,
        })),
        install_script: generated.installScript,
        cargo_toml: generated.cargoToml,
        context_rule_config: generated.contextRuleConfig,
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse('CODEGEN_ERROR', message);
  }
}

// ---------------------------------------------------------------------------
// Tool: simulate_policy
// ---------------------------------------------------------------------------

export const simulatePolicyTool = {
  name: 'simulate_policy',
  description:
    'Run the permit/deny simulation harness against the generated policy. Tests the original tx (must permit) and auto-generated mutations (must deny). Call generate_code first.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      session_id: { type: 'string' },
      network: {
        type: 'string',
        enum: ['mainnet', 'testnet', 'futurenet'],
        description: 'Network for simulation. Default: testnet.',
      },
      smart_account_id: { type: 'string', description: 'Smart account address.' },
    },
    required: ['session_id'],
  },
};

export async function handleSimulatePolicy(input: Record<string, unknown>): Promise<unknown> {
  const maybeSession = safeRequireSession(input.session_id as string);
  if (isErrorResult(maybeSession)) return maybeSession;
  const session = maybeSession as Session;

  if (!session.generatedCode) {
    return errorResponse('NO_GENERATED_CODE', 'Run generate_code first.');
  }

  let network: Network;
  try {
    network = validateNetwork(input.network ?? 'testnet');
  } catch (err) {
    return errorResponse('INVALID_INPUT', err instanceof Error ? err.message : String(err));
  }

  try {
    const permitCases = session.recordedTxs.map((tx, idx) => ({
      id: `permit-${idx}`,
      description: `Original recorded transaction: ${tx.hash}`,
      tx,
    }));

    const report = await runHarness(
      session.generatedCode.proposalId,
      permitCases,
      session.generatedCode,
      {
        network,
        smartAccountId: input.smart_account_id as string | undefined,
        dryRun: true,
      },
    );

    session.simulationReport = report;

    return {
      ok: true,
      data: {
        session_id: session.id,
        coverage_score: report.coverageScore,
        summary: report.summary,
        permit_results: report.permitResults.map((r) => ({
          id: r.caseId,
          description: r.description,
          passed: r.passed,
          actual: r.actual,
          expected: r.expected,
          error: r.errorMessage,
        })),
        deny_results: report.denyResults.map((r) => ({
          id: r.caseId,
          description: r.description,
          passed: r.passed,
          actual: r.actual,
          expected: r.expected,
          error: r.errorMessage,
        })),
        issues: report.issues,
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse('SIMULATION_ERROR', message);
  }
}

// ---------------------------------------------------------------------------
// Tool: get_simulation_report
// ---------------------------------------------------------------------------

export const getSimulationReportTool = {
  name: 'get_simulation_report',
  description: 'Retrieve the latest simulation report for a session.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      session_id: { type: 'string' },
    },
    required: ['session_id'],
  },
};

export function handleGetSimulationReport(input: Record<string, unknown>): unknown {
  const maybeSession = safeRequireSession(input.session_id as string);
  if (isErrorResult(maybeSession)) return maybeSession;
  const session = maybeSession as Session;

  if (!session.simulationReport) {
    return errorResponse('NO_REPORT', 'Run simulate_policy first.');
  }

  return { ok: true, data: session.simulationReport };
}

// ---------------------------------------------------------------------------
// Tool: install_policy (builds unsigned XDR)
// ---------------------------------------------------------------------------

export const installPolicyTool = {
  name: 'install_policy',
  description:
    'Build the unsigned install transaction XDR. The user must sign and submit this separately. Requires generate_code and simulate_policy to have been completed.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      session_id: { type: 'string' },
      smart_account_id: { type: 'string', description: 'Smart account address (C-address).' },
      deployed_policy_addresses: {
        type: 'array',
        items: { type: 'string' },
        description: 'Addresses of deployed custom policy contracts.',
      },
    },
    required: ['session_id', 'smart_account_id'],
  },
};

export function handleInstallPolicy(input: Record<string, unknown>): unknown {
  const maybeSession = safeRequireSession(input.session_id as string);
  if (isErrorResult(maybeSession)) return maybeSession;
  const session = maybeSession as Session;

  if (!session.generatedCode) {
    return errorResponse('NO_GENERATED_CODE', 'Run generate_code first.');
  }

  if (!session.simulationReport) {
    return errorResponse('NO_SIMULATION', 'Run simulate_policy first to verify the policy before installing.');
  }

  if (session.simulationReport.coverageScore < 0.8) {
    return {
      ok: false,
      error: {
        code: 'LOW_COVERAGE',
        message: `Simulation coverage is ${(session.simulationReport.coverageScore * 100).toFixed(0)}% — below the 80% minimum. Review and fix issues before installing.`,
        details: { issues: session.simulationReport.issues },
      },
    };
  }

  const deployedAddresses = (input.deployed_policy_addresses as string[]) ?? [];
  const generated = session.generatedCode;

  // Build the install configuration that the user's wallet SDK will use
  const installConfig = {
    smart_account: input.smart_account_id as string,
    context_rule: {
      ...generated.contextRuleConfig,
      policy_addresses: deployedAddresses,
    },
    install_script: generated.installScript,
    instructions: [
      '1. Review the context_rule configuration above.',
      '2. If custom policies were generated, compile and deploy them first (fill their addresses in deployed_policy_addresses).',
      '3. Use your OZ-compatible wallet SDK to call installContextRule() with the context_rule config.',
      '4. Sign and submit the transaction.',
      '5. Verify installation with your wallet.',
    ],
  };

  return {
    ok: true,
    data: installConfig,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorResponse(code: string, message: string, details?: unknown): unknown {
  return { ok: false, error: { code, message, details } };
}

const VALID_NETWORKS = ['mainnet', 'testnet', 'futurenet'] as const;

function validateNetwork(network: unknown): Network {
  if (!VALID_NETWORKS.includes(network as Network)) {
    throw new Error(`Invalid network "${network}". Must be one of: ${VALID_NETWORKS.join(', ')}`);
  }
  return network as Network;
}

function safeRequireSession(sessionId: string): ReturnType<typeof requireSession> | { ok: false; error: unknown } {
  try {
    return requireSession(sessionId);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'SESSION_NOT_FOUND',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

function isErrorResult(x: unknown): x is { ok: false; error: unknown } {
  return typeof x === 'object' && x !== null && (x as { ok?: unknown }).ok === false;
}
