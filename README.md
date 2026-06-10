# OZ Accounts Policy Builder

**AI-assisted record-and-generate toolkit for crafting OpenZeppelin smart account policies on Stellar.**

> Stellar RMF Track — AI/Agent-Readiness & Smart Account Adoption — Q2 2026

---

## What It Does

Record a Stellar transaction → get a minimal, auditable policy that permits exactly that flow and nothing else.

```
observe tx → synthesize policy → simulate → review → deploy
```

The tool never auto-deploys. It generates human-readable, compilable Rust code that you review and deploy as a separate explicit step.

## Architecture

```
packages/
  tx-recorder/         Stellar RPC tx fetch + invocation parsing
  policy-synthesizer/  AI-assisted synthesis + Rust code generation
  sim-harness/         Permit/deny simulation testing
  mcp-server/          MCP server (record, synthesize, simulate, install)
  agent-skill/         Claude conversational skill wrapping the MCP

contracts/
  shared/policy-trait/ OZ Policy trait + shared types
  policies/
    spending-limit/    Asset spending cap (period-based)
    time-bound/        Ledger range enforcement
    call-filter/       (Contract, function, args) allowlist
    frequency-limit/   Max N calls per period
    composite/         AND-compose up to 8 sub-policies
```

---

## Prerequisites

- Node.js v22 (`nvm use 22`)
- Rust + Cargo (`~/.cargo/bin/cargo`)
- An Anthropic API key (for the AI synthesizer)

---

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/YOUR_USERNAME/OZ-accounts-policy-builder.git
cd OZ-accounts-policy-builder

# 2. Install Node dependencies
npm install

# 3. Build all TypeScript packages
npm run build

# 4. Set your Anthropic API key
cp .env.example .env
# Edit .env and set ANTHROPIC_API_KEY=sk-ant-...

# 5. Build Rust contracts
~/.cargo/bin/cargo build --workspace
```

---

## Running the Demo

The demo script runs all three demo options and saves all output to `demo/output/`.

```bash
bash demo/run-demo.sh
```

### What the demo covers

**Option 1 — MCP Server (HTTP/SSE mode)**

Starts the MCP server on `http://localhost:3000`.

```bash
# Start manually
OZ_POLICY_MCP_HTTP=1 OZ_POLICY_MCP_HTTP_PORT=3000 \
  node packages/mcp-server/dist/index.js

# Verify it is running
curl http://localhost:3000/health
# → {"ok":true,"transport":"http-sse","activeSessions":0}

# Connect Claude as an MCP client
claude mcp add oz-policy http://localhost:3000/mcp
```

Available endpoints:
| Endpoint | Description |
|----------|-------------|
| `GET /health` | Server status |
| `GET /mcp` | SSE stream — connect any MCP client here |
| `POST /messages` | Send MCP tool calls |

**Option 2 — Test Suites**

```bash
# TypeScript tests (48 tests)
npm test

# Rust contract tests (20 tests across 5 contracts)
~/.cargo/bin/cargo test --workspace
```

**Option 3 — Policy Synthesis + Wallet XDR Generation**

Runs the full pipeline end-to-end in Node.js without a live blockchain:

```bash
node --input-type=module << 'EOF'
import { StrKey } from '@stellar/stellar-sdk';
import { generateTimeBoundSource } from './packages/policy-synthesizer/dist/codegen.js';
import { encodeTimeBoundParams, buildAddContextRuleTx } from './packages/policy-synthesizer/dist/wallet.js';

const ACCOUNT = StrKey.encodeContract(Buffer.alloc(32, 4));
const POOL    = StrKey.encodeContract(Buffer.alloc(32, 2));
const POLICY  = StrKey.encodeContract(Buffer.alloc(32, 3));

// 1. Generate Rust contract source
const { source, cargoToml } = generateTimeBoundSource({
  kind: 'custom_time_bound', isStandardOz: false,
  label: 'Blend Yield Delegate', contractName: 'blend_yield_policy',
  config: { kind: 'custom_time_bound', startLedger: 1000000, endLedger: 1500000 },
  rationale: 'Bound Blend yield claim delegation to a 90-day window'
});
console.log('Generated contract length:', source.length, 'chars');

// 2. Encode install params to XDR
const paramsXdr = encodeTimeBoundParams(1000000, 1500000);
console.log('Install params XDR:', paramsXdr.slice(0, 40) + '...');

// 3. Build wallet operations
const { addContextRuleXdr, addPolicyXdrTemplate } = buildAddContextRuleTx({
  walletContractId: ACCOUNT, ruleName: 'Blend yield delegation',
  targetContract: POOL, policyAddr: POLICY, installParamsXdr: paramsXdr,
  networkPassphrase: 'Test SDF Network ; September 2015', validUntilLedger: 1500000,
});
console.log('add_context_rule op XDR:', addContextRuleXdr.slice(0, 40) + '...');
console.log('add_policy op XDR:', addPolicyXdrTemplate.slice(0, 40) + '...');
EOF
```

All generated artifacts are saved to `demo/output/`:

| File | Contents |
|------|----------|
| `typescript-tests.txt` | Full output of 48 passing TS tests |
| `rust-tests.txt` | Full output of 20 passing Rust tests |
| `rust-build.txt` | Workspace build output |
| `mcp-tools-manifest.json` | All 8 MCP tool schemas |
| `mcp-server-health.json` | Live server health response |
| `install-params-xdr.json` | XDR for TimeBound, SpendingLimit, FrequencyLimit, CallFilter params |
| `wallet-operations-xdr.json` | add_context_rule + add_policy + execute op XDRs |
| `codegen-wallet-demo.txt` | Option 3 console output |
| `generated/blend_yield_policy/` | Generated time-bound Rust contract |
| `generated/soroswap_dca_policy/` | Generated call-filter Rust contract |
| `generated/sep41_subscription_policy/` | Generated frequency-limit Rust contract |

---

## Using the MCP Server with Claude

Add to your Claude Code MCP config:

```json
{
  "mcpServers": {
    "oz-accounts-policy-builder": {
      "command": "node",
      "args": ["/path/to/oz-accounts-policy-builder/packages/mcp-server/dist/index.js"],
      "env": {
        "ANTHROPIC_API_KEY": "your_key_here"
      }
    }
  }
}
```

Then in Claude:

```
Record this testnet transaction and generate a policy for me:
tx_hash: a3f4b2c1d8e9f0a1...
```

Claude will walk you through the full record → synthesize → simulate → install flow.

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `record_transaction` | Record tx by hash or XDR |
| `list_invocations` | List all contract calls in session |
| `synthesize_policy` | Generate policy proposal |
| `answer_clarification` | Answer policy questions |
| `generate_code` | Get Rust source + install script |
| `simulate_policy` | Run permit/deny test harness |
| `get_simulation_report` | Fetch simulation results |
| `install_policy` | Build unsigned install config |

---

## Compiling Policy Contracts

```bash
# Build all contracts
~/.cargo/bin/cargo build --release --workspace

# Run all contract tests
~/.cargo/bin/cargo test --workspace

# Build a specific policy
~/.cargo/bin/cargo build --release -p oz-policy-spending-limit
```

---

## Three Example Walkthroughs

- [Blend Yield Claim → USDC](docs/walkthroughs/blend-yield-claim.md)
- [SEP-41 Monthly Subscription](docs/walkthroughs/sep41-subscription.md)
- [Soroswap Bounded DCA](docs/walkthroughs/soroswap-delegation.md)

---

## Security

Generated policy contracts:
- Use `#![no_std]` and `soroban-sdk` only
- No `unsafe` blocks
- Storage always double-keyed by `(smart_account, context_rule_id)`
- All arithmetic uses `checked_*` variants
- `overflow-checks = true` enforced at workspace level

The synthesizer biases toward minimal permissions. Spending caps default to the observed maximum. Users must explicitly opt up.

**Generated code must be audited before mainnet use.**

---

## License

Apache-2.0
