/**
 * OZ Policy Builder — Claude Agent Skill
 *
 * Wraps the MCP server with a high-level conversational interface.
 * Knows when to ask for clarification vs. when to apply defaults.
 *
 * Compatible with:
 *   - Claude Code (as a /skill)
 *   - Claude API tool use (anthropic.messages.create)
 *   - Any agent framework supporting MCP
 */

import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You are the OZ Policy Builder Agent — a Stellar smart account security specialist.

Your job is to help users create OpenZeppelin smart account policies from real or simulated Stellar transactions. You translate "I want to let an agent do X" into a minimal, auditable Soroban policy contract.

## Your capabilities (via MCP tools)

- **record_transaction**: Record a Stellar tx by hash or XDR
- **list_invocations**: See all contract calls in recorded txs
- **synthesize_policy**: Generate a policy proposal with clarifying questions
- **answer_clarification**: Submit answers to policy questions
- **generate_code**: Generate Rust policy source + install script
- **simulate_policy**: Test the policy (permit + deny cases)
- **install_policy**: Build the install transaction config

## Decision rules

### When to ask vs. when to assume

ALWAYS ask:
1. Spending cap: "Should the cap be the exact observed amount (<observedAmount>) or a larger budget?"
2. Lifetime: "How long should this policy be active? (Default: 90 days for agent delegation)"
3. Recipient constraint: "Should transfers be locked to the specific recipient observed, or to any recipient?"

NEVER ask (just assume with explanation):
- Scope: Always use exactly the observed (contract, function) pairs — no extras
- Direction: Cap outbound only, not inbound
- Whether to include a policy: Yes if there are spending constraints; no if not

### Clarifying question prompts

Use these phrasings when the data is ambiguous:
- Amounts: "I observed a <amount> <asset> transfer. Should the spending cap be <amount> (tight) or a higher budget like <amount * 2> weekly?"
- Lifetime: "This delegation would expire in 90 days. Is that right, or do you want a longer window like 1 year?"
- Recipients: "All <count> observed transfers went to <recipient>. Should I pin the policy to that address, or allow any recipient?"

### Code generation

After getting answers, always:
1. Show the user the generated context rule config (JSON)
2. Show any custom Rust policy source files
3. Explain what each policy does in plain English
4. Run the simulation harness and show the coverage score
5. Only offer install_policy if coverage ≥ 80%

### Safety reminders

Always remind the user:
- Generated code must be reviewed before deployment
- Custom policy contracts must be audited before use on mainnet
- The install step is always manual and explicit
- Deployment to mainnet should be preceded by testnet verification

## Stellar/Soroban context

- SAC tokens (SEP-41) have 7 decimal places
- C-addresses are Stellar smart account addresses (contract accounts)
- OZ standard policies: spending_limit, simple_threshold, weighted_threshold
- Custom policies implement: install / can_enforce / enforce / uninstall
- Policies are scoped per (smart_account, context_rule_id) — no global state

## Examples of good responses

User: "Record this tx and generate a policy for me: [hash]"
→ Record → Synthesize → Ask 2-3 key questions → Generate → Simulate → Explain

User: "I want to delegate Blend yield claiming to an agent"
→ Ask for a sample tx hash or simulate one → then follow the flow

User: "What does this policy allow?"
→ Explain the scope + policies in plain English, including what it denies
`;

// ---------------------------------------------------------------------------
// MCP client wrapper
// ---------------------------------------------------------------------------

export class PolicyBuilderSkill {
  private client: Client | null = null;
  private anthropic: Anthropic;
  private mcpServerCommand: string;
  private mcpServerArgs: string[];
  private conversationHistory: Anthropic.MessageParam[] = [];

  constructor(
    anthropicApiKey?: string,
    mcpServerCommand = 'node',
    mcpServerArgs = ['./packages/mcp-server/dist/index.js'],
  ) {
    this.anthropic = new Anthropic({ apiKey: anthropicApiKey ?? process.env.ANTHROPIC_API_KEY });
    this.mcpServerCommand = mcpServerCommand;
    this.mcpServerArgs = mcpServerArgs;
  }

  async connect(): Promise<void> {
    const transport = new StdioClientTransport({
      command: this.mcpServerCommand,
      args: this.mcpServerArgs,
    });
    this.client = new Client({ name: 'oz-policy-agent', version: '0.1.0' }, { capabilities: {} });
    await this.client.connect(transport);
  }

  /** High-level conversational interface. */
  async chat(userMessage: string): Promise<string> {
    this.conversationHistory.push({ role: 'user', content: userMessage });

    const tools = await this.getAvailableTools();

    const response = await this.anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: this.conversationHistory,
      tools,
    });

    // Handle tool use loop
    const finalResponse = await this.handleToolUseLoop(response, tools);

    this.conversationHistory.push({ role: 'assistant', content: finalResponse });

    // Extract text content
    return typeof finalResponse === 'string'
      ? finalResponse
      : finalResponse
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
  }

  private async handleToolUseLoop(
    response: Anthropic.Message,
    tools: Anthropic.Tool[],
  ): Promise<string | Anthropic.ContentBlock[]> {
    if (response.stop_reason !== 'tool_use') {
      return response.content;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      const result = await this.callTool(block.name, block.input as Record<string, unknown>);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result, null, 2),
      });
    }

    this.conversationHistory.push({
      role: 'assistant',
      content: response.content,
    });
    this.conversationHistory.push({
      role: 'user',
      content: toolResults,
    });

    const nextResponse = await this.anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: this.conversationHistory,
      tools,
    });

    return this.handleToolUseLoop(nextResponse, tools);
  }

  private async callTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    if (!this.client) {
      throw new Error('MCP client not connected. Call connect() first.');
    }
    const result = await this.client.callTool({ name, arguments: input });
    return result;
  }

  private async getAvailableTools(): Promise<Anthropic.Tool[]> {
    if (!this.client) {
      return getStaticToolDefinitions();
    }
    const { tools } = await this.client.listTools();
    return tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
    }));
  }

  /**
   * Record a transaction and immediately synthesize a policy proposal.
   * Spec §5.5: record_and_synthesize entry point.
   */
  async recordAndSynthesize(txHashOrXdr: string, smartAccountId?: string): Promise<string> {
    const accountClause = smartAccountId ? ` for smart account ${smartAccountId}` : '';
    return this.chat(
      `Record this transaction and synthesize a policy${accountClause}: ${txHashOrXdr}`,
    );
  }

  /**
   * Synthesize a policy from a natural-language description (no sample tx required).
   * Spec §5.5: synthesize_from_description entry point.
   */
  async synthesizeFromDescription(description: string): Promise<string> {
    return this.chat(
      `I want to create a policy with these constraints: ${description}\n` +
      `Please synthesize a context rule and policy based on this description. ` +
      `Ask me clarifying questions if needed.`,
    );
  }

  /**
   * Review generated Rust policy source for security issues and correctness.
   * Spec §5.5: review_generated_policy entry point.
   */
  async reviewGeneratedPolicy(rustSource: string): Promise<string> {
    return this.chat(
      `Please review this generated Soroban policy contract for security issues, ` +
      `correctness, and Stellar best practices:\n\n\`\`\`rust\n${rustSource}\n\`\`\``,
    );
  }

  /**
   * Explain what a policy allows and denies in plain English.
   * Spec §5.5: explain_policy entry point. Accepts JSON spec, Rust source, or prose.
   */
  async explainPolicy(policySpec: string): Promise<string> {
    return this.chat(
      `Explain what this policy allows and denies in plain English, ` +
      `including concrete examples of permitted and rejected invocations:\n\n${policySpec}`,
    );
  }

  reset(): void {
    this.conversationHistory = [];
  }
}

// ---------------------------------------------------------------------------
// Static tool definitions (for when MCP server is not running)
// ---------------------------------------------------------------------------

function getStaticToolDefinitions(): Anthropic.Tool[] {
  return [
    {
      name: 'record_transaction',
      description: 'Record a Stellar transaction by hash or XDR',
      input_schema: {
        type: 'object' as const,
        properties: {
          tx_hash: { type: 'string' },
          tx_xdr: { type: 'string' },
          network: { type: 'string', enum: ['mainnet', 'testnet', 'futurenet'] },
          session_id: { type: 'string' },
        },
      },
    },
    {
      name: 'synthesize_policy',
      description: 'Synthesize a context rule and policy from recorded transactions',
      input_schema: {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string' },
          smart_account_id: { type: 'string' },
          interactive: { type: 'boolean' },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'answer_clarification',
      description: 'Answer clarifying questions from synthesize_policy',
      input_schema: {
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
            },
          },
        },
        required: ['session_id', 'answers'],
      },
    },
    {
      name: 'generate_code',
      description: 'Generate Rust policy code and install script',
      input_schema: {
        type: 'object' as const,
        properties: { session_id: { type: 'string' } },
        required: ['session_id'],
      },
    },
    {
      name: 'simulate_policy',
      description: 'Run permit/deny simulation harness',
      input_schema: {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string' },
          network: { type: 'string', enum: ['mainnet', 'testnet', 'futurenet'] },
          smart_account_id: { type: 'string' },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'install_policy',
      description: 'Build the unsigned install transaction config',
      input_schema: {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string' },
          smart_account_id: { type: 'string' },
          deployed_policy_addresses: { type: 'array', items: { type: 'string' } },
        },
        required: ['session_id', 'smart_account_id'],
      },
    },
  ];
}

