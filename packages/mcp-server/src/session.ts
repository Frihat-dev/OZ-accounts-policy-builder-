/**
 * In-memory session store for multi-step MCP workflows.
 * TTL: 1 hour per session.
 */

import { randomBytes } from 'node:crypto';
import type { RecordedTransaction } from '@oz-policy-builder/tx-recorder';
import type { PolicyProposal, GeneratedCode } from '@oz-policy-builder/policy-synthesizer';
import type { SimulationReport } from '@oz-policy-builder/sim-harness';

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_SESSIONS = 10_000; // prevent unbounded memory growth

export interface Session {
  id: string;
  createdAt: number;
  updatedAt: number;
  recordedTxs: RecordedTransaction[];
  proposal: PolicyProposal | null;
  clarifications: Map<string, string>;
  generatedCode: GeneratedCode | null;
  simulationReport: SimulationReport | null;
}

const sessions = new Map<string, Session>();

export function createSession(): Session {
  if (sessions.size >= MAX_SESSIONS) {
    // Evict the oldest session before creating a new one
    const oldestId = sessions.keys().next().value as string;
    sessions.delete(oldestId);
  }

  const id = generateSessionId();
  const session: Session = {
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    recordedTxs: [],
    proposal: null,
    clarifications: new Map(),
    generatedCode: null,
    simulationReport: null,
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id: string): Session | null {
  const session = sessions.get(id);
  if (!session) return null;

  // Expire stale sessions
  if (Date.now() - session.updatedAt > SESSION_TTL_MS) {
    sessions.delete(id);
    return null;
  }

  session.updatedAt = Date.now();
  return session;
}

export function requireSession(id: string): Session {
  const session = getSession(id);
  if (!session) {
    throw new Error(`Session "${id}" not found or expired. Start a new session with record_transaction.`);
  }
  return session;
}

export function deleteSession(id: string): void {
  sessions.delete(id);
}

/** Periodic cleanup of expired sessions. */
export function startSessionCleanup(): NodeJS.Timeout {
  return setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.updatedAt > SESSION_TTL_MS) {
        sessions.delete(id);
      }
    }
  }, 5 * 60 * 1000); // every 5 minutes
}

function generateSessionId(): string {
  return 'sess_' + randomBytes(16).toString('hex');
}
