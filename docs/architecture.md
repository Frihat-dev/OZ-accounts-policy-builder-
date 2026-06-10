# Architecture Deep-Dive

## Repository Layout

```
oz-policy-builder/
├── TECHNICAL_SPEC.md          Full product + engineering specification
├── Cargo.toml                  Rust workspace root
├── package.json                TypeScript monorepo root (npm workspaces)
├── tsconfig.base.json          Shared TypeScript config
│
├── contracts/                  Soroban smart contracts (Rust)
│   ├── shared/
│   │   └── policy-trait/      OZ Policy trait + shared types
│   └── policies/
│       ├── spending-limit/    Asset spending cap (period-based)
│       ├── time-bound/        Ledger/timestamp window enforcement
│       ├── call-filter/       Allowlist of (contract, fn, args)
│       ├── frequency-limit/   Max N calls per period
│       └── composite/         AND-compose ≤4 sub-policies
│
├── packages/                   TypeScript packages (npm workspaces)
│   ├── tx-recorder/           Stellar tx fetch + parse
│   ├── policy-synthesizer/    AI-assisted synthesis + codegen
│   ├── sim-harness/           Permit/deny simulation runner
│   ├── mcp-server/            MCP server (stdio + HTTP)
│   └── agent-skill/           Claude conversational skill
│
├── docs/
│   ├── architecture.md        (this file)
│   ├── policy-synthesis-algorithm.md
│   ├── mcp-api-reference.md
│   └── walkthroughs/
│       ├── blend-yield-claim.md
│       ├── sep41-subscription.md
│       └── soroswap-delegation.md
│
└── tests/
    ├── synthesizer/            Unit tests for synthesis logic
    ├── e2e/                    End-to-end MCP + simulation tests
    └── fixtures/               Recorded tx JSON fixtures
```

## Dependency Graph

```
agent-skill
    └── mcp-server (MCP client)
         ├── tx-recorder
         ├── policy-synthesizer
         │    └── Rust policy templates (codegen templates)
         └── sim-harness
              └── Soroban RPC
```

## Key Design Decisions

### 1. TypeScript for orchestration, Rust for contracts

The MCP server, synthesizer, and harness are TypeScript because:
- Stellar SDK (`@stellar/stellar-sdk`) is first-class TS
- Claude API integration is TS-native
- MCP SDK is TS-native
- Fast iteration cycles for AI prompts

Policies are Rust because:
- Soroban contracts must be compiled to WASM
- Type safety for on-chain logic is critical
- Existing OZ ecosystem is Rust

### 2. Template-then-AI codegen

Policy code generation works in two layers:
- Layer 1: Template-based (Handlebars) — deterministic for known policy types
- Layer 2: AI-assisted (Claude) — fills in novel constraints not covered by templates

This ensures the common case (spending limits, time bounds) is always deterministic and auditable. AI is only used for genuinely novel constraints.

### 3. Sessions for multi-step workflows

The MCP server maintains in-memory sessions (TTL 1h) so agents can:
```
record → [session_id created]
synthesize [session_id] → [proposal + questions]
answer_clarification [session_id, q_id, answer]
generate_code [session_id] → [code]
simulate [session_id] → [report]
```

This enables a natural conversational flow without the agent having to pass the full tx data on every call.

### 4. Minimal-permission bias

The synthesizer always errs toward denying more:
- Scope = exactly the observed (contract, fn) pairs, never more
- Spending cap = observed amount (user must opt-up)
- Lifetime = prompted, with a safe default (90 days for agent delegation)
- Args = exact observed values for fixed args (e.g. recipient address)

### 5. Code-first, deploy-second

The tool never submits transactions automatically. The final output is:
- A JSON context rule configuration (for OZ install call)
- Rust source files (for custom policies that need deployment)
- A TypeScript install helper script (for the user to review and run)

The user (or separately authorized agent) compiles, deploys custom policies, then runs the install helper.
