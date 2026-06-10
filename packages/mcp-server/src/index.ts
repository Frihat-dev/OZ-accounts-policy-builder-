#!/usr/bin/env node
/**
 * OZ Policy Builder — MCP Server
 *
 * Exposes recording, synthesis, simulation, and install capabilities
 * as MCP tools for AI agents.
 *
 * Transport:
 *   stdio (default)          — for local Claude Code / CLI use
 *   HTTP/SSE (remote)        — set OZ_POLICY_MCP_HTTP=1, port via OZ_POLICY_MCP_HTTP_PORT (default 3000)
 *
 * Usage:
 *   node dist/index.js                                 # stdio
 *   OZ_POLICY_MCP_HTTP=1 node dist/index.js           # HTTP+SSE on port 3000
 *   OZ_POLICY_MCP_HTTP=1 OZ_POLICY_MCP_HTTP_PORT=8080 node dist/index.js
 */

import { createServer as createHttpServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  recordTransactionTool,
  handleRecordTransaction,
  listInvocationsTool,
  handleListInvocations,
  synthesizePolicyTool,
  handleSynthesizePolicy,
  answerClarificationTool,
  handleAnswerClarification,
  generateCodeTool,
  handleGenerateCode,
  simulatePolicyTool,
  handleSimulatePolicy,
  getSimulationReportTool,
  handleGetSimulationReport,
  installPolicyTool,
  handleInstallPolicy,
} from './tools.js';
import { startSessionCleanup } from './session.js';

// ---------------------------------------------------------------------------
// Shared tool configuration
// ---------------------------------------------------------------------------

const TOOLS = [
  recordTransactionTool,
  listInvocationsTool,
  synthesizePolicyTool,
  answerClarificationTool,
  generateCodeTool,
  simulatePolicyTool,
  getSimulationReportTool,
  installPolicyTool,
];

function registerHandlers(server: Server): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const input = (args ?? {}) as Record<string, unknown>;
    let result: unknown;

    try {
      switch (name) {
        case 'record_transaction':    result = await handleRecordTransaction(input); break;
        case 'list_invocations':      result = handleListInvocations(input); break;
        case 'synthesize_policy':     result = await handleSynthesizePolicy(input); break;
        case 'answer_clarification':  result = handleAnswerClarification(input); break;
        case 'generate_code':         result = await handleGenerateCode(input); break;
        case 'simulate_policy':       result = await handleSimulatePolicy(input); break;
        case 'get_simulation_report': result = handleGetSimulationReport(input); break;
        case 'install_policy':        result = handleInstallPolicy(input); break;
        default:
          result = { ok: false, error: { code: 'UNKNOWN_TOOL', message: `Unknown tool: ${name}` } };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      result = { ok: false, error: { code: 'INTERNAL_ERROR', message } };
    }

    return { content: [{ type: 'text', text: JSON.stringify(result, safeJsonReplacer, 2) }] };
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

startSessionCleanup();

async function startStdio(): Promise<void> {
  const server = new Server({ name: 'oz-policy-builder', version: '0.1.0' }, { capabilities: { tools: {} } });
  registerHandlers(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[oz-policy-mcp] Server running on stdio');
}

async function startHttp(port: number): Promise<void> {
  // Each SSE connection gets its own Server instance so concurrent remote
  // clients can't interfere. Sessions (in session.ts) are shared via the
  // module-level Map, so a client can call multiple tools in sequence.
  const sseTransports = new Map<string, SSEServerTransport>();

  const httpServer = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    // CORS — permit any origin for local-network agent use
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // GET /mcp — open SSE stream
    if (req.method === 'GET' && url.pathname === '/mcp') {
      const transport = new SSEServerTransport('/messages', res);
      const sessionId = transport.sessionId;
      sseTransports.set(sessionId, transport);
      transport.onclose = () => sseTransports.delete(sessionId);

      const server = new Server(
        { name: 'oz-policy-builder', version: '0.1.0' },
        { capabilities: { tools: {} } },
      );
      registerHandlers(server);
      server.connect(transport).catch((err: unknown) => {
        console.error('[oz-policy-mcp] SSE connect error:', err);
      });
      console.error(`[oz-policy-mcp] SSE stream opened: ${sessionId}`);
      return;
    }

    // POST /messages — client sends tool calls
    if (req.method === 'POST' && url.pathname === '/messages') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const transport = sseTransports.get(sessionId);
      if (!transport) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `SSE session ${sessionId} not found` }));
        return;
      }

      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        transport.handlePostMessage(req, res, JSON.parse(body || '{}')).catch((err: unknown) => {
          console.error('[oz-policy-mcp] handlePostMessage error:', err);
          if (!res.headersSent) { res.writeHead(500); res.end(); }
        });
      });
      return;
    }

    // Health check
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, transport: 'http-sse', activeSessions: sseTransports.size }));
      return;
    }

    res.writeHead(404);
    res.end('Not found. Available: GET /mcp, POST /messages, GET /health');
  });

  await new Promise<void>((resolve) => httpServer.listen(port, '0.0.0.0', resolve));
  console.error(`[oz-policy-mcp] HTTP/SSE server running on http://0.0.0.0:${port}`);
  console.error(`[oz-policy-mcp]   SSE endpoint:      GET  http://localhost:${port}/mcp`);
  console.error(`[oz-policy-mcp]   Messages endpoint: POST http://localhost:${port}/messages?sessionId=<id>`);
  console.error(`[oz-policy-mcp]   Health check:      GET  http://localhost:${port}/health`);
}

const useHttp = process.env.OZ_POLICY_MCP_HTTP === '1';
const httpPort = parseInt(process.env.OZ_POLICY_MCP_HTTP_PORT ?? '3000', 10);

if (useHttp) {
  startHttp(httpPort).catch((err) => {
    console.error('[oz-policy-mcp] Fatal error (HTTP):', err);
    process.exit(1);
  });
} else {
  startStdio().catch((err) => {
    console.error('[oz-policy-mcp] Fatal error (stdio):', err);
    process.exit(1);
  });
}

// Serialize BigInt in JSON responses
function safeJsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
