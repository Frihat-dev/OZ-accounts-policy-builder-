# OZ Accounts Policy Builder — Technical Architecture

**Version:** 1.0.0  
**Status:** Active  
**Track:** Stellar RMF — AI / Agent-Readiness & Smart Account Adoption (Q2 2026)  
**Last Updated:** 2026-06-15

---

## How It Works

OZ Accounts Policy Builder converts observed Stellar transactions into deployable
OpenZeppelin Smart Account policies — automatically, with minimal human effort.

The core idea: **show the tool what an agent does, and it derives the minimal
permission set that covers exactly that behaviour and nothing more.**

### End-to-End Workflow

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    HOW OZ ACCOUNTS POLICY BUILDER WORKS                         │
└─────────────────────────────────────────────────────────────────────────────────┘

  You (developer or AI agent)
        │
        │  "I want to delegate Soroswap trading to a bot — here is a sample tx"
        │
        ▼
┌───────────────────┐
│   1. RECORD       │  Feed a real Stellar transaction hash (or XDR).
│                   │  The tool fetches it from Horizon, parses every
│   tx hash / XDR  │  contract call, resolves asset transfers (SAC tokens
│   → call graph    │  with 7-decimal precision), and unwraps fee-bump
│   → asset flows   │  envelopes and execute() sub-invocations.
└────────┬──────────┘
         │
         │  RecordedTransaction: {invocations[], assetTransfers[], ledgerChanges[]}
         ▼
┌───────────────────┐
│   2. SYNTHESIZE   │  AI engine runs 6 stages:
│                   │    ① Extract call graph → ContextRule scope
│   call graph      │    ② Infer delegation lifetime (default 90 days)
│   + asset flows   │    ③ Derive asset spending caps from observed amounts
│   → policy set    │    ④ Select policy types (spending / time / frequency /
│   + questions     │       call-filter / composite)
│                   │    ⑤ Generate Rust code (template-first, AI for novel cases)
│                   │    ⑥ Surface clarifying questions for ambiguous parameters
└────────┬──────────┘
         │
         │  PolicyProposal: {context_rule, policies[], clarifying_questions[]}
         ▼
┌───────────────────┐
│   3. CLARIFY      │  The tool asks only what it cannot infer:
│                   │    • "Confirm spending cap: 500 USDC/day?"
│   Q&A loop        │    • "Delegation lifetime: 90 days?"
│   tightens the    │    • "Lock recipient address to observed value?"
│   policy output   │  You answer; the proposal tightens. One round is typical.
└────────┬──────────┘
         │
         │  Refined PolicyProposal + GeneratedCode (Rust source + install script)
         ▼
┌───────────────────┐
│   4. SIMULATE     │  Before any on-chain action, the harness runs the
│                   │  generated policy against Soroban RPC:
│   permit cases    │    ✓ Permit cases — intended txs must pass
│   deny cases      │    ✗ Deny cases  — 6 mutation types must all fail:
│   → coverage      │        exceed_spending · wrong_asset · out_of_window
│     report        │        extra_invocation · expired_rule · wrong_function
│                   │  Coverage score (0.0–1.0) tells you how well the
│                   │  policy blocks the full attack surface.
└────────┬──────────┘
         │
         │  SimulationReport: {permit_results[], deny_results[], coverage_score}
         ▼
┌───────────────────┐
│   5. REVIEW       │  All output is human-readable before any deployment:
│                   │    • Rust policy contract source (compilable, auditable)
│   Rust source     │    • TypeScript install helper script
│   install script  │    • JSON ContextRule configuration
│   XDR preview     │    • Unsigned XDR for add_context_rule + add_policy
│                   │  The tool NEVER submits a transaction automatically.
└────────┬──────────┘
         │
         │  WalletIntegrationBundle: {unsigned XDR × N, install_script.ts}
         ▼
┌───────────────────┐
│   6. DEPLOY       │  You compile, deploy (if a new contract is needed),
│                   │  and sign + submit the install XDR.
│   sign & submit   │  On-chain writes are always user-initiated.
│   → policy lives  │
│     on-chain      │  Result: the OZ Smart Account now enforces the policy
│                   │  on every invocation that matches the delegated scope.
└───────────────────┘
```

### What Gets Generated

Depending on the observed transaction, the tool produces one of two outputs:

```
Mode (a) — OZ Primitive is sufficient
  Output: JSON config for an existing OZ policy (simple_threshold,
          weighted_threshold, spending_limit)
  → No new contract needed. Install directly.

Mode (b) — Novel constraint required
  Output: compilable Rust source + Cargo.toml + TypeScript install helper
  → Compile → deploy WASM → install on smart account.

  Generated contracts are always:
    • #![no_std]  ·  no unsafe blocks  ·  double-keyed storage
    • overflow-checks = true  ·  only soroban-sdk imports
```

### The Five Policy Types

```
  "How much can be spent?"  →  spending-limit   (asset cap + period reset)
  "During which window?"    →  time-bound        (start/end ledger range)
  "Which calls exactly?"    →  call-filter       (contract + fn + arg constraints)
  "How many times?"         →  frequency-limit   (max N calls per window)
  "All constraints at once" →  composite         (AND-compose up to 8 policies)
```

### How an AI Agent Uses It

```
  AI Agent                        OZ Policy Builder (MCP Server)
     │                                       │
     │── record_transaction(tx_hash) ───────►│ parse tx, store in session
     │◄─ {session_id, invocations[]} ────────│
     │                                       │
     │── synthesize_policy(session_id) ─────►│ 6-stage synthesis
     │◄─ {proposal, questions[]} ────────────│
     │                                       │
     │── answer_clarification(q_id, ans) ───►│ refine proposal
     │◄─ {updated_proposal} ─────────────────│
     │                                       │
     │── generate_code(session_id) ─────────►│ Handlebars + Claude API
     │◄─ {rust_source, install_script} ──────│
     │                                       │
     │── simulate_policy(session_id) ───────►│ Soroban RPC permit/deny run
     │◄─ {coverage_score, issues[]} ─────────│
     │                                       │
     │── install_policy(session_id) ────────►│ build unsigned XDR
     │◄─ {add_context_rule_xdr,              │
     │    add_policy_xdr[]} ─────────────────│
     │                                       │
  (human signs + submits XDR)
     │
     ▼
  Policy live on Stellar ✓
```

---

## Table of Contents

0. [How It Works](#how-it-works) — start here for a plain-English overview
1. [Stellar Stack Context](#1-stellar-stack-context)
2. [SCF Grant — Default vs. This Implementation](#2-scf-grant--default-vs-this-implementation)
3. [System Architecture Overview](#3-system-architecture-overview)
4. [Stellar Integration Deep-Dive](#4-stellar-integration-deep-dive)
5. [Component Architecture](#5-component-architecture)
6. [End-to-End Data Flow](#6-end-to-end-data-flow)
7. [Smart Contract Architecture](#7-smart-contract-architecture) — §7.3 explains why exactly 5 policy contracts
8. [AI Integration Architecture](#8-ai-integration-architecture)
9. [Security Architecture](#9-security-architecture)
10. [Deployment Architecture](#10-deployment-architecture)
11. [Error Handling & Failure Modes](#11-error-handling--failure-modes)

---

## 1. Stellar Stack Context

### 1.1 The Stellar Technology Stack

This tool integrates with multiple layers of the Stellar ecosystem. Understanding those layers is essential to understanding how the builder fits in.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         STELLAR NETWORK STACK                               │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Layer 4 — Application Layer                                         │   │
│  │                                                                       │   │
│  │   OZ Policy Builder (this tool)   Wallets   DeFi dApps   AI Agents  │   │
│  └───────────────────────────────┬───────────────────────────────────────┘  │
│                                  │                                           │
│  ┌───────────────────────────────▼───────────────────────────────────────┐  │
│  │  Layer 3 — Smart Account Layer (OZ Accounts on Soroban)               │  │
│  │                                                                         │  │
│  │   SmartAccount (C-address)                                              │  │
│  │   ├── Signers[]          — who can act (G-address, passkeys, etc.)    │  │
│  │   ├── ContextRules[]     — scoped delegations (contract + fn pairs)   │  │
│  │   └── Policies[]         — enforcement modules (WASM contracts)       │  │
│  └───────────────────────────────┬───────────────────────────────────────┘  │
│                                  │                                           │
│  ┌───────────────────────────────▼───────────────────────────────────────┐  │
│  │  Layer 2 — Soroban (Smart Contract Runtime)                           │  │
│  │                                                                         │  │
│  │   WASM execution engine · Host functions · Ledger storage             │  │
│  │   XDR encoding/decoding · Authorization framework                     │  │
│  │   SAC (Stellar Asset Contract) interface                               │  │
│  └───────────────────────────────┬───────────────────────────────────────┘  │
│                                  │                                           │
│  ┌───────────────────────────────▼───────────────────────────────────────┐  │
│  │  Layer 1 — Stellar Core / Consensus                                   │  │
│  │                                                                         │  │
│  │   SCP consensus · Ledger closes (≈ 5s) · Classic operations           │  │
│  │   Transaction envelopes · Horizon (REST API) · Soroban RPC            │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Where OZ Policy Builder Touches the Stack

| Stack Layer | Touch Point | How |
|------------|------------|------|
| **Stellar Core** | Transaction envelopes, ledger data | Via Horizon REST + XDR parsing |
| **Soroban RPC** | `simulate_transaction` | For permit/deny simulation (never `send_transaction`) |
| **Soroban Contracts** | Policy WASM deployment and invocation | Generates + tests compilable Rust |
| **OZ Smart Accounts** | ContextRule install, policy interface | Generates OZ-compatible config + code |
| **SAC Tokens** | Asset transfer extraction (7 decimal places) | Parsed from `InvokeHostFunctionOp` |
| **Stellar SDK** | All network operations | `@stellar/stellar-sdk` v15.1.0 |

### 1.3 OpenZeppelin Accounts Model on Soroban

The OZ Accounts framework implements smart accounts as Soroban contracts. A smart account authorizes actions through a layered permission system:

```
SmartAccount (C-address)
│
├── Signer (Delegated: G-address)
│   └── Authorized for ContextRule #1 only
│
├── ContextRule #1  ─────────────────────────────────────────────────────┐
│   ├── scope: [(soroswap_router, swap_exact_tokens_for_tokens)]          │
│   ├── valid_until: ledger 1_500_000                                     │
│   └── policies: [SpendingLimitPolicy, CallFilterPolicy]                 │
│                  │                      │                               │
│                  ▼                      ▼                               │
│         enforce(ctx, signers,  enforce(ctx, signers,                    │
│                 rule, account)         rule, account)                   │
│         → deduct budget        → check args                             │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Authorization flow for every Soroban call through a smart account:**

```
Incoming Invocation
       │
       ▼
 Smart Account Contract
       │
       ├─ 1. Find matching ContextRule (scope check: contract + fn name)
       │      No match → DENY (scope enforcement, before policies)
       │
       ├─ 2. Verify signer is listed in the rule's signer set
       │      Not listed → DENY
       │
       ├─ 3. Check rule.valid_until vs current ledger
       │      Expired → DENY
       │
       └─ 4. For each Policy in rule.policies:
              └─ call policy.enforce(context, signers, rule, account)
                 Panic / error → DENY
                 All pass → ALLOW ✓
```

---

## 2. SCF Grant — Default vs. This Implementation

### 2.1 What the SCF Grant Specified as the Initial Implementation

The Stellar Community Fund (SCF) grant for AI/Agent-Readiness in the Smart Account Adoption track referenced **pollywallet** (kalepail/pollywallet) as the canonical reference implementation. The grant's baseline expectations for policy tooling were:

| Dimension | SCF / pollywallet Baseline |
|-----------|--------------------------|
| Policy interface | Custom per-project: `install(BytesN<32>, Map<Symbol,Val>)` |
| Storage keys | `BytesN<32>` hash — developer-chosen, collision-prone |
| Install parameters | Untyped `Map<Symbol, Val>` — schema undocumented |
| ArgConstraint types | Address-only (exact recipient match) |
| Composite policies | Up to 4 sub-policies |
| Fee-bump transaction support | None |
| Auth tree traversal | No — only top-level invocation inspected |
| `execute()` decomposition | No — sub-invocations of execute() not parsed |
| Wallet XDR builder | None — developers hand-craft install transactions |
| Code generator | None — all policy code hand-written |
| AI synthesis | None — developer manually designs policies |
| Policy lifecycle methods | 2 (`install`, `enforce`) |
| Simulation / deny-case testing | None — dev deploys and hopes |

### 2.2 OZ Policy Builder — Improvements Over the Baseline

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                    COMPARISON: Baseline vs. OZ Policy Builder                  │
├────────────────────────────┬──────────────────────┬────────────────────────────┤
│ Dimension                  │ SCF Baseline          │ OZ Policy Builder          │
├────────────────────────────┼──────────────────────┼────────────────────────────┤
│ Policy interface           │ Custom, per-project   │ OZ trait (4 lifecycle fns) │
│ context_rule_id type       │ BytesN<32> hash       │ u32 (monotonic, reuse-safe)│
│ Install parameters         │ Map<Symbol,Val>       │ Typed structs per policy   │
│ ArgConstraint types        │ Address-only (1 type) │ 4 types:                   │
│                            │                       │  ExactAddress, ExactValue  │
│                            │                       │  AmountMax, AmountMin      │
│ Composite max sub-policies │ 4                     │ 8                          │
│ Fee-bump support           │ None                  │ Full (parses inner tx)     │
│ Auth tree traversal        │ Top-level only        │ Full recursive traversal   │
│ execute() decomposition    │ No                    │ Yes (synthetic child invs) │
│ Wallet XDR builder         │ None                  │ add_context_rule +         │
│                            │                       │ add_policy + execute XDRs  │
│ Code generator             │ None                  │ Template + AI (2-layer)    │
│ AI synthesis               │ None                  │ Claude-powered full suite  │
│ Policy lifecycle methods   │ 2                     │ 4 (install, can_enforce,   │
│                            │                       │    enforce, uninstall)      │
│ Permit/deny simulation     │ None                  │ Full harness (6 mutations) │
│ MCP tool surface           │ None                  │ 8 tools via MCP server     │
│ End-to-end walkthroughs    │ None                  │ 3 documented walkthroughs  │
│ Storage key collision risk │ High (BytesN<32>)     │ Zero (double-keyed u32)    │
│ Audit-ready output         │ No                    │ Yes (Rust + install script)│
└────────────────────────────┴──────────────────────┴────────────────────────────┘
```

### 2.3 Key Technical Differentiators Explained

**1. Typed context_rule_id (`u32` vs `BytesN<32>`)**

The baseline approach used a developer-chosen `BytesN<32>` hash as the policy storage key. This causes:
- Silent key collision if two rules hash identically
- No canonical ordering of rules
- No guaranteed uniqueness across accounts

OZ Policy Builder uses `context_rule.id: u32` — a monotonically incrementing ID assigned by the OZ smart account itself. It is unique-per-account, never reused after deletion, and directly passed in the `ContextRule` struct by the smart account during every policy call.

**2. Typed install parameters**

Baseline used `Map<Symbol, Val>` — a runtime-typed map that silently fails if keys are missing or values are the wrong type. OZ Policy Builder uses named Rust structs (`SpendingLimitParams`, `TimeBoundParams`, etc.) that fail at compile time if misconfigured.

**3. Four policy lifecycle methods vs. two**

The baseline only had `install` and `enforce`. OZ Policy Builder adds:
- `can_enforce` — cheap read-only pre-check (avoids state mutation for infeasible calls)
- `uninstall` — ledger rent recovery when a context rule is removed

**4. Full transaction parsing vs. surface-only**

The baseline inspected only top-level invocations. OZ Policy Builder:
- Traverses the full auth tree recursively
- Decomposes `execute()` calls into synthetic child invocations
- Handles fee-bump envelopes (extracts the inner transaction)
- Resolves SAC token transfers with correct 7-decimal precision

**5. AI synthesis layer**

The baseline had no automation — developers had to manually design policies by reading contract source code. OZ Policy Builder records a transaction and synthesizes the minimal safe policy automatically, surfacing clarifying questions only when ambiguity exists.

---

## 3. System Architecture Overview

### 3.1 High-Level Architecture

```
╔═══════════════════════════════════════════════════════════════════════════╗
║                     OZ ACCOUNTS POLICY BUILDER                           ║
║                                                                           ║
║  ┌──────────────────────────────────────────────────────────────────┐    ║
║  │                     Entry Points                                   │    ║
║  │                                                                    │    ║
║  │   ┌─────────────────┐          ┌──────────────────────────┐      │    ║
║  │   │  Claude Skill   │          │   Any MCP-capable Agent  │      │    ║
║  │   │  (agent-skill/) │          │  (Claude Code, Claude    │      │    ║
║  │   │                 │          │   Desktop, custom agent) │      │    ║
║  │   │  Natural lang.  │          │                          │      │    ║
║  │   │  conversational │          │   Direct tool calls      │      │    ║
║  │   │  interface      │          │   via MCP protocol       │      │    ║
║  │   └────────┬────────┘          └───────────┬──────────────┘      │    ║
║  │            │                               │                      │    ║
║  │            └───────────────┬───────────────┘                      │    ║
║  └────────────────────────────┼─────────────────────────────────────┘    ║
║                               │                                           ║
║  ┌────────────────────────────▼─────────────────────────────────────┐    ║
║  │                      MCP Server (mcp-server/)                     │    ║
║  │                                                                    │    ║
║  │  Transport: stdio (local) │ HTTP/SSE (remote, OZ_POLICY_MCP_HTTP) │    ║
║  │                                                                    │    ║
║  │  8 Tools:  record_transaction    list_invocations                  │    ║
║  │            synthesize_policy     answer_clarification              │    ║
║  │            generate_code         simulate_policy                   │    ║
║  │            get_simulation_report install_policy                    │    ║
║  │                                                                    │    ║
║  │  Session store (in-memory, TTL 1h):                               │    ║
║  │  session_id → {recorded_txs, proposal, clarifications,            │    ║
║  │                generated_code, simulation_report}                 │    ║
║  └───┬──────────────────────┬──────────────────┬────────────────────┘    ║
║      │                      │                  │                          ║
║  ┌───▼──────────┐   ┌───────▼──────────┐  ┌───▼─────────────────────┐   ║
║  │ tx-recorder  │   │policy-synthesizer│  │     sim-harness          │   ║
║  │              │   │                  │  │                           │   ║
║  │ Horizon RPC  │   │ Rule builder     │  │ Permit-case runner        │   ║
║  │ Soroban RPC  │   │ Policy selector  │  │ Deny-case mutations       │   ║
║  │ XDR parser   │   │ Rust codegen     │  │ Coverage reporter         │   ║
║  │ SAC decoder  │   │ Claude API       │  │ Soroban RPC simulator     │   ║
║  └───┬──────────┘   └──────────────────┘  └───┬─────────────────────┘   ║
║      │                                         │                          ║
╚══════╪═════════════════════════════════════════╪══════════════════════════╝
       │                                         │
       ▼                                         ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                         STELLAR NETWORK                                   │
│                                                                           │
│   Horizon API              Soroban RPC              Testnet / Mainnet     │
│   ┌──────────────┐         ┌──────────────┐         ┌──────────────────┐ │
│   │ GET /tx/{hash}│         │ simulate_tx  │         │  OZ Smart Account│ │
│   │ GET /ledger  │         │ send_tx      │         │  Policy contracts │ │
│   │ GET /effects │         │ get_ledger   │         │  SAC tokens       │ │
│   └──────────────┘         └──────────────┘         └──────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Package Dependency Graph

```
agent-skill
    │
    └──► mcp-server  ◄─── [stdio / HTTP/SSE transport]
              │
              ├──► tx-recorder
              │       └── @stellar/stellar-sdk v15.1.0
              │           ├── Horizon Server (REST)
              │           └── SorobanRpc.Server
              │
              ├──► policy-synthesizer
              │       ├── tx-recorder (types)
              │       ├── Anthropic Claude API (claude-sonnet-4-6+)
              │       └── Handlebars templates
              │           ├── spending_limit.rs.hbs
              │           ├── time_bound.rs.hbs
              │           ├── call_filter.rs.hbs
              │           ├── frequency_limit.rs.hbs
              │           └── composite.rs.hbs
              │
              └──► sim-harness
                      ├── policy-synthesizer (GeneratedCode types)
                      └── SorobanRpc.Server (simulate_transaction)
```

---

## 4. Stellar Integration Deep-Dive

### 4.1 Transaction Recording Layer

The `tx-recorder` package is the bridge between the Stellar network and the synthesis pipeline.

```
                    STELLAR NETWORK
                         │
         ┌───────────────┼───────────────┐
         │               │               │
    Horizon REST    Soroban RPC     Local XDR
    GET /tx/{hash}  (for sim)      (dev/test)
         │               │               │
         └───────────────┼───────────────┘
                         │
                    tx-recorder
                         │
         ┌───────────────┼───────────────────────┐
         │               │                       │
   Fee-bump         InvokeHost           Auth Tree
   unwrap           FunctionOp           Traversal
   (get inner tx)   decoder              (recursive)
         │               │                       │
         └───────────────┼───────────────────────┘
                         │
              ┌──────────▼──────────┐
              │  RecordedTransaction │
              │  ─────────────────── │
              │  hash                │
              │  network             │
              │  ledger              │
              │  invocations[]       │◄── (contract, fn, args, subInvocations)
              │  assetTransfers[]    │◄── (SAC token moves, 7 decimals)
              │  ledgerChanges[]     │◄── (storage footprint deltas)
              │  rawEnvelope (XDR)   │
              └─────────────────────┘
```

**SAC Token Precision:** Stellar Asset Contracts represent amounts with 7 decimal places (stroops). The recorder converts all amounts to `bigint` in stroops to avoid floating-point rounding — critical for spending limit accuracy.

**Fee-Bump Handling:** Stellar fee-bump transactions wrap an inner transaction with a separate fee payer. The recorder unwraps the outer envelope and processes the inner transaction, preserving the original auth structure.

**Auth Tree Traversal:** Soroban's authorization framework allows sub-invocations — a contract calling another contract under a delegated authorization. The recorder recursively visits all auth nodes to build the complete invocation tree.

**`execute()` Decomposition:** The OZ smart account's `execute()` function is a top-level invocation that itself invokes the actual target contract. The recorder detects `execute()` calls and injects the sub-invocations as synthetic children in the invocation tree, ensuring the synthesizer sees the real target (e.g., `soroswap_router.swap`) not just `oz_account.execute`.

### 4.2 Soroban RPC Integration

```
SorobanRpc.Server  ←──  mcp-server (tool: simulate_policy)
      │
      ├── simulateTransaction(tx_xdr)
      │       └── Returns: SimulateTransactionResponse
      │               ├── result (XDR)
      │               ├── cost (instructions, read/write bytes)
      │               ├── events (contract events)
      │               └── stateChanges (ledger footprint)
      │
      └── sendTransaction(signed_tx_xdr)  [NOT used — user signs separately]
```

The simulation harness calls `simulate_transaction` only — it never submits real transactions. Results are compared to expected outcomes (permit: success, deny: failure with `PolicyError`).

### 4.3 OZ Smart Account Integration

```
OZ Smart Account Contract (live on Stellar)
│
├── add_context_rule(rule_spec)         ← builder generates unsigned XDR
├── add_policy(rule_id, policy_address) ← builder generates unsigned XDR
├── remove_context_rule(rule_id)
├── set_signer(signer_spec)
└── execute(contract, fn, args)        ← what the delegated agent calls

           ▲
           │  User reviews + signs install XDR
           │
    install_policy MCP tool
    └── WalletIntegrationBundle
        ├── add_context_rule XDR  (unsigned)
        ├── add_policy XDR        (unsigned, one per policy)
        └── execute XDR           (example invocation for verification)
```

The builder never submits transactions. It produces unsigned XDR that the wallet or user must sign and submit — preserving human control over the critical install step.

### 4.4 Soroban Contract Compilation Flow

```
Code Generator (TypeScript)
        │
        └─► Rust source files (spending_limit.rs, etc.)
                │
                └─► Cargo.toml
                        │
                        └─► cargo build --target wasm32-unknown-unknown
                                │
                                └─► target/wasm32-unknown-unknown/release/policy.wasm
                                        │
                                        ├─► soroban contract upload (deploy WASM)
                                        │       └─► WASM hash (contract code)
                                        │
                                        └─► soroban contract deploy --wasm-hash
                                                └─► C-address (policy contract instance)
                                                        │
                                                        └─► add_policy(rule_id, C-address)
```

---

## 5. Component Architecture

### 5.1 `tx-recorder` — Stellar Transaction Parser

**Language:** TypeScript | **Stellar SDK:** `@stellar/stellar-sdk` v15.1.0

```
┌─────────────────────────────────────────────────────────────────────┐
│                          tx-recorder                                 │
│                                                                       │
│  Public API:                                                          │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  recordFromHash(hash, network, options?)                     │    │
│  │  recordFromSimulation(SimulateTransactionResponse, envelope) │    │
│  │  recordFromXdr(envelopeXdr, network)                        │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                           │                                           │
│  Internal pipeline:       │                                           │
│  ┌────────────────────────▼──────────────────────────────────────┐  │
│  │  fetchTx         → Horizon.Server.loadTransaction(hash)       │  │
│  │  unwrapFeeBump   → xdr.FeeBumpTransaction inner extraction     │  │
│  │  parseOps        → filter InvokeHostFunctionOp operations      │  │
│  │  buildInvTree    → recursive SubInvocation traversal           │  │
│  │  decomposeExec   → detect execute(), inject child invocations  │  │
│  │  extractSAC      → SAC transfer events (xfer_from, transfer)   │  │
│  │  decodeLedger    → LedgerKey changes from footprint            │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

**Key types:**

```typescript
interface RecordedTransaction {
  hash: string;
  network: 'mainnet' | 'testnet' | 'simulation';
  ledger: number;
  timestamp: number;
  fee: bigint;                    // in stroops
  invocations: Invocation[];
  assetTransfers: AssetTransfer[];
  ledgerChanges: LedgerEntry[];
  rawEnvelope: string;            // base64 XDR
}

interface Invocation {
  contractId: string;             // C-address
  contractName?: string;          // resolved from metadata
  functionName: string;
  args: InvocationArg[];
  subInvocations: Invocation[];   // recursive
  success: boolean;
  returnValue?: unknown;
}

interface AssetTransfer {
  assetCode: string;
  issuer?: string;                // undefined for XLM
  from: string;
  to: string;
  amount: bigint;                 // in stroops (7 decimals)
}
```

### 5.2 `policy-synthesizer` — AI-Assisted Policy Engine

**Language:** TypeScript | **AI:** Anthropic Claude API (`claude-sonnet-4-6`)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        policy-synthesizer                                │
│                                                                           │
│   Input: RecordedTransaction[]                                            │
│                                                                           │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │  Stage 1 — Call Graph Extraction                                 │   │
│   │  • Flatten invocation trees → (contractId, functionName) pairs  │   │
│   │  • Deduplicate, preserving unique pairs                          │   │
│   │  • This forms the minimum ContextRule scope                      │   │
│   └───────────────────────────────┬─────────────────────────────────┘   │
│                                   │                                       │
│   ┌───────────────────────────────▼─────────────────────────────────┐   │
│   │  Stage 2 — Lifetime Inference                                     │   │
│   │  • Default: 90 days (agent delegation) / 1 year (subscription)   │   │
│   │  • Use tx time bounds as hint if present                          │   │
│   │  • Always surface as clarifying question                          │   │
│   └───────────────────────────────┬─────────────────────────────────┘   │
│                                   │                                       │
│   ┌───────────────────────────────▼─────────────────────────────────┐   │
│   │  Stage 3 — Asset Constraint Selection                             │   │
│   │  • Per AssetTransfer: record (asset, amount, direction)           │   │
│   │  • Group by asset: max observed = candidate spending limit         │   │
│   │  • Infer per-period budget for recurring flows                    │   │
│   └───────────────────────────────┬─────────────────────────────────┘   │
│                                   │                                       │
│   ┌───────────────────────────────▼─────────────────────────────────┐   │
│   │  Stage 4 — Policy Selection                                       │   │
│   │                                                                    │   │
│   │  spending bound?     → spending_limit policy                       │   │
│   │  time window?        → time_bound policy                           │   │
│   │  call rate cap?      → frequency_limit policy                      │   │
│   │  specific arg values? → call_filter policy                         │   │
│   │  multiple constraints? → composite (AND-compose up to 8)           │   │
│   └───────────────────────────────┬─────────────────────────────────┘   │
│                                   │                                       │
│   ┌───────────────────────────────▼─────────────────────────────────┐   │
│   │  Stage 5 — Code Generation (2-layer approach)                     │   │
│   │                                                                    │   │
│   │  Layer 1: Template-based (Handlebars) — known policy types         │   │
│   │           always deterministic and auditable                        │   │
│   │                                                                    │   │
│   │  Layer 2: AI-assisted (Claude API) — novel constraints only        │   │
│   │           Claude fills in logic for constraints not in templates    │   │
│   │           Synthesizer enforces: no unsafe, no bare panic!,         │   │
│   │           storage double-keyed, overflow-checks = true             │   │
│   └───────────────────────────────┬─────────────────────────────────┘   │
│                                   │                                       │
│   ┌───────────────────────────────▼─────────────────────────────────┐   │
│   │  Stage 6 — Clarifying Questions                                   │   │
│   │  • Any ambiguous parameter → ClarifyingQuestion                   │   │
│   │  • Always ask: spending cap amount, lifetime duration             │   │
│   │  • Assume: minimal scope, outbound-only cap, observed arg values  │   │
│   └───────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│   Output: PolicyProposal                                                  │
│   {context_rule: ContextRuleSpec, policies: PolicySpec[],                │
│    rationale: string, questions: ClarifyingQuestion[]}                   │
└─────────────────────────────────────────────────────────────────────────┘
```

### 5.3 `sim-harness` — Permit/Deny Test Runner

**Language:** TypeScript | **Backend:** Soroban RPC `simulate_transaction`

```
┌──────────────────────────────────────────────────────────────────┐
│                         sim-harness                               │
│                                                                    │
│  Input: GeneratedCode + permit_cases[] + deny_cases[]             │
│                                                                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Permit-case runner                                          │  │
│  │  • Build valid invocations matching policy scope            │  │
│  │  • Simulate against Soroban RPC                             │  │
│  │  • Expect: success (no PolicyError panic)                   │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Deny-case mutation engine (6 mutation types)               │  │
│  │                                                              │  │
│  │  exceed_spending    — amount × factor > limit               │  │
│  │  wrong_asset        — substitute different SAC contract     │  │
│  │  out_of_window      — ledger offset outside valid range     │  │
│  │  extra_invocation   — add unauthorized contract call        │  │
│  │  expired_rule       — set valid_until to past ledger        │  │
│  │  wrong_function     — call function not in scope            │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Coverage reporter                                           │  │
│  │  • permit_results: CaseResult[]                             │  │
│  │  • deny_results: CaseResult[]                               │  │
│  │  • coverage_score: number  (deny cases covered / total, 0–1)│  │
│  │  • issues: Issue[]  (unexpected pass/fail)                  │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### 5.4 `mcp-server` — Agent Interface

**Language:** TypeScript | **Framework:** `@modelcontextprotocol/sdk` | **Transport:** stdio + HTTP/SSE

```
┌─────────────────────────────────────────────────────────────────┐
│                        mcp-server                                │
│                                                                   │
│  8 MCP Tools:                                                     │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  record_transaction(tx_hash|tx_xdr, network)              │  │
│  │      └─► RecordedTransaction + session_id                 │  │
│  │                                                             │  │
│  │  list_invocations(session_id)                              │  │
│  │      └─► All (contract, fn) pairs in recorded txs          │  │
│  │                                                             │  │
│  │  synthesize_policy(session_id, smart_account_id)           │  │
│  │      └─► PolicyProposal + clarifying questions             │  │
│  │                                                             │  │
│  │  answer_clarification(session_id, question_id, answer)     │  │
│  │      └─► Updated PolicyProposal                            │  │
│  │                                                             │  │
│  │  generate_code(session_id)                                  │  │
│  │      └─► GeneratedCode (Rust sources + install script)     │  │
│  │                                                             │  │
│  │  simulate_policy(session_id, permit_cases, deny_cases)     │  │
│  │      └─► SimulationReport                                  │  │
│  │                                                             │  │
│  │  get_simulation_report(session_id)                         │  │
│  │      └─► Cached SimulationReport                           │  │
│  │                                                             │  │
│  │  install_policy(session_id)                                 │  │
│  │      └─► Unsigned install transaction XDR                  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                   │
│  Response envelope (all tools):                                   │
│  { ok: true, data: {...} }                                        │
│  { ok: false, error: {code, message, details} }                  │
│                                                                   │
│  Session model (in-memory, TTL 1h):                               │
│  Session {                                                        │
│    id: string                                                     │
│    recorded_txs: RecordedTransaction[]                            │
│    proposal: PolicyProposal | null                                │
│    clarifications: Map<string, string>                            │
│    generated_code: GeneratedCode | null                           │
│    simulation_report: SimulationReport | null                     │
│  }                                                                │
└─────────────────────────────────────────────────────────────────┘
```

### 5.5 `agent-skill` — Conversational Claude Wrapper

**Language:** TypeScript | **Format:** Claude skill (Claude Code / Claude API tool use)

```
┌──────────────────────────────────────────────────────────────────┐
│                        agent-skill                                │
│                                                                    │
│  Entry Points:                                                     │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  record_and_synthesize                                       │  │
│  │    trigger: "record this tx and generate a policy"          │  │
│  │                                                              │  │
│  │  synthesize_from_description                                 │  │
│  │    trigger: "I want to delegate Blend yield claiming"       │  │
│  │                                                              │  │
│  │  review_generated_policy                                     │  │
│  │    trigger: "review the generated policy for me"            │  │
│  │                                                              │  │
│  │  explain_policy                                              │  │
│  │    trigger: "what does this policy allow/deny?"             │  │
│  │                                                              │  │
│  │  propose_delegation                                          │  │
│  │    trigger: agent self-declaration workflow                  │  │
│  │    input:   PlannedOp[] — planned (contract, fn, args,      │  │
│  │             frequency, amounts) tuples                       │  │
│  │    output:  minimal policy set + plain-English allow/deny   │  │
│  │             summary + unsigned install XDR for human review  │  │
│  │    note:    no on-chain action until human signs XDR        │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  Clarification logic:                                              │
│  ALWAYS ASK: spending cap, lifetime duration, arg scope           │
│  ASSUME:     minimal scope, outbound-only cap, observed args      │
└──────────────────────────────────────────────────────────────────┘
```

---

## 6. End-to-End Data Flow

### 6.1 Full Pipeline Diagram

```
USER / AGENT
    │
    │  1. "Record tx 0xabc123 on testnet and synthesize a policy"
    │
    ▼
agent-skill ──► record_transaction MCP tool
                       │
                       ▼
                  tx-recorder
                  ├── Horizon GET /transactions/0xabc123
                  ├── Parse InvokeHostFunctionOp
                  ├── Unwrap fee-bump (if present)
                  ├── Traverse auth tree recursively
                  ├── Decompose execute() calls
                  └── Extract SAC transfers (bigint stroops)
                       │
                       ▼
                  RecordedTransaction
                  {hash, invocations[], assetTransfers[], ...}
                  [stored in session, session_id returned]
                       │
    │  2. "Now synthesize the policy for account CDXXX"
    │
    ▼
agent-skill ──► synthesize_policy MCP tool
                       │
                       ▼
                  policy-synthesizer
                  ├── Extract call graph → context rule scope
                  ├── Infer lifetime (90 days default)
                  ├── Group asset transfers → spending limit candidates
                  ├── Match against policy types
                  └── Claude API → rationale + clarifying questions
                       │
                       ▼
                  PolicyProposal
                  {context_rule, policies[], questions[]}
                       │
    │  3. Agent/user answers clarifying questions
    │
    ▼
agent-skill ──► answer_clarification (repeat per question)
                       │
                       ▼
                  Updated PolicyProposal (stored in session)
                       │
    │  4. "Generate the code"
    │
    ▼
agent-skill ──► generate_code MCP tool
                       │
                       ▼
                  policy-synthesizer (codegen)
                  ├── Layer 1: Handlebars template → Rust source
                  │   (spending_limit, time_bound, call_filter,
                  │    frequency_limit, composite)
                  └── Layer 2: Claude API → novel constraint logic
                       │
                       ▼
                  GeneratedCode
                  {context_rule_config, policy_contracts[],
                   install_script.ts, Cargo.toml}
                       │
    │  5. "Simulate it"
    │
    ▼
agent-skill ──► simulate_policy MCP tool
                       │
                       ▼
                  sim-harness
                  ├── Build permit-case transactions
                  ├── Build deny-case mutations (6 types)
                  └── Soroban RPC simulate_transaction for each
                       │
                       ▼
                  SimulationReport
                  {permit_results[], deny_results[],
                   coverage_score, issues[]}
                       │
    │  6. User reviews report, approves
    │
    ▼
agent-skill ──► install_policy MCP tool
                       │
                       ▼
                  policy-synthesizer (wallet XDR builder)
                  ├── add_context_rule XDR (unsigned)
                  ├── add_policy XDR × N  (unsigned)
                  └── execute XDR (example, unsigned)
                       │
                       ▼
              WalletIntegrationBundle (returned to user)
                       │
    │  7. User signs + submits manually (or via wallet UI)
    │
    ▼
  STELLAR NETWORK  ──► Context rule installed ✓
```

### 6.2 Session State Machine

```
[INIT]
  │
  ▼
[RECORDED]  ← record_transaction
  │
  ▼
[PROPOSED]  ← synthesize_policy
  │
  ├──(questions remain)──► [CLARIFYING] ← answer_clarification
  │                              │
  │                              └──(all answered)──► [PROPOSED]
  │
  ▼
[GENERATED] ← generate_code
  │
  ▼
[SIMULATED] ← simulate_policy / simulate_policy (re-run)
  │
  ▼
[INSTALL_READY] ← install_policy
  │
  ▼
[DONE]  (user signs + submits externally)
```

---

## 7. Smart Contract Architecture

### 7.1 Actual Policy Trait Interface

The actual function signatures used in all policy contracts (note: `ContextRule` struct is passed directly, not a `BytesN<32>` ID):

```rust
// contracts/shared/policy-trait/src/lib.rs

/// Full context rule as passed by the OZ smart account to policy entry-points.
/// id is a monotonically incrementing u32 unique within one smart account.
#[contracttype]
pub struct ContextRule {
    pub id: u32,                      // storage key (NOT BytesN<32>)
    pub context_type: ContextRuleType,
    pub name: String,
    pub signers: Vec<Signer>,
    pub signer_ids: Vec<u32>,
    pub policies: Vec<Address>,
    pub policy_ids: Vec<u32>,
    pub valid_until: Option<u32>,     // ledger sequence number, None = no expiry
}

// All policy contracts expose these four functions:

fn install(
    env: Env,
    install_params: PolicyParams,     // typed struct per policy (NOT Map<Symbol,Val>)
    context_rule: ContextRule,        // full rule passed by smart account
    smart_account: Address,
)

fn enforce(
    env: Env,
    context: Context,                 // soroban_sdk::auth::Context
    authenticated_signers: Vec<Signer>,
    context_rule: ContextRule,
    smart_account: Address,
)

fn uninstall(
    env: Env,
    context_rule: ContextRule,
    smart_account: Address,
)

fn can_enforce(
    env: Env,
    context: Context,
    context_rule: ContextRule,
    smart_account: Address,
) -> bool                             // read-only pre-check, returns false vs. panicking
```

### 7.2 Policy Contract Inventory

```
contracts/
├── shared/
│   └── policy-trait/            OZ-compatible types + PolicyError codes
│
└── policies/
    ├── spending-limit/          Asset spending cap with period reset
    │   ├── SpendingLimitParams  {asset: Address, limit: i128, period_secs: u64}
    │   ├── SpendingConfig       immutable (set at install)
    │   └── SpendingState        mutable (period_start: u64, spent: i128)
    │
    ├── time-bound/              Ledger sequence window enforcement
    │   ├── TimeBoundParams      {start_ledger: u32, end_ledger: u32}
    │   └── TimeBoundConfig      immutable (set at install)
    │
    ├── call-filter/             Allowlist of (contract, fn, args) triples
    │   ├── CallFilterParams     {allowed_calls: Vec<AllowedCall>}
    │   └── ArgConstraint        ExactAddress | ExactValue | AmountMax | AmountMin
    │
    ├── frequency-limit/         Max N calls per time window
    │   ├── FrequencyParams      {max_calls: u32, window_secs: u64}
    │   ├── FrequencyConfig      immutable
    │   └── FrequencyState       mutable (window_start: u64, call_count: u32)
    │
    └── composite/               AND-compose up to 8 sub-policies
        ├── CompositeParams      {sub_policies: Vec<Address>}
        └── CompositeConfig      {sub_policies: Vec<Address>}  MAX = 8
```

### 7.3 Why Exactly 5 Policy Contracts — RFP-Derived Completeness Argument

The 5 deployable policy contracts are not an arbitrary count. They are the **minimal complete
set** derived from three sources: the RFP §3 requirements text, the OZ Accounts authorization
model, and the 8 `PolicyError` codes defined in `oz-policy-trait`.

#### 7.3.1 The RFP Explicitly Names the Required Constraint Types

RFP §3.2 states: *"the smallest set of policies needed to constrain the rule (e.g. spending
limits derived from the observed amounts, frequency limits, time bounds)."*

These three phrases map to three of the four net-new contracts:

```
RFP §3.2 phrase           → Contract
─────────────────────────────────────────────
"spending limits"         → spending-limit
"frequency limits"        → frequency-limit
"time bounds"             → time-bound
"must not permit a third" → call-filter  (argument-level scope enforcement)
"AND-combine all of them" → composite    (single policy slot, multiple constraints)
```

#### 7.3.2 The OZ Primitives the Synthesizer Composes First (RFP §3.3)

RFP §3.3: *"leveraging existing OZ-provided policy primitives (simple_threshold,
weighted_threshold, spending_limit) wherever they suffice."*

```
OZ Primitive          Composed when…
────────────────────────────────────────────────────────────────────────
simple_threshold      Single-signer delegation; no additional constraint
weighted_threshold    Multi-signer / threshold approval requirement
spending_limit        Basic amount cap; no period-reset or SAC precision needed
```

When OZ's `spending_limit` is sufficient, the synthesizer configures it directly (mode a)
and does NOT generate a net-new contract. Our `spending-limit` contract is the production-
hardened extension used when the OZ primitive is insufficient (e.g., SAC 7-decimal precision,
per-period reset, or typed `SpendingLimitParams`).

#### 7.3.3 The PolicyError Codes Confirm the Constraint Space is Covered

Each of the 8 `PolicyError` codes in `oz-policy-trait/src/lib.rs` is owned by a specific
contract. If a 6th contract existed, it would need at least one error code that is not
already covered — and no such code exists:

```
PolicyError code         Owned by
────────────────────────────────────────────────────
NotInstalled          =  all 5 contracts (install guard)
SpendingLimitExceeded =  spending-limit
FrequencyLimitExceeded = frequency-limit
TimeWindowViolation   =  time-bound
ScopeViolation        =  call-filter
InvalidConfig         =  composite + all (config validation)
AlreadyInstalled      =  all 5 contracts (double-install guard)
Unauthorized          =  time-bound (extend_window admin-only)
```

No unclaimed error code exists → no 6th contract is needed.

#### 7.3.4 The Constraint-Space Coverage Argument

The four constraint dimensions that cover any delegation scenario:

```
┌────────────────────────────────────────────────────────────────────┐
│         COMPLETE DELEGATION CONSTRAINT SPACE                        │
│                                                                      │
│   "How much?"     →  spending-limit   (asset amount cap)            │
│   "When?"         →  time-bound       (ledger/timestamp window)     │
│   "What exactly?" →  call-filter      (argument-level enforcement)  │
│   "How often?"    →  frequency-limit  (invocation rate cap)         │
│   "All of above?" →  composite        (AND-compose ≤8 sub-policies) │
│                                                                      │
│   Removing ANY one of these contracts leaves a constraint class      │
│   the synthesizer cannot express:                                    │
│   • No spending-limit → no asset amount control                     │
│   • No time-bound     → no start-window gating (valid_until only    │
│                         ends a rule; it does not start-gate it)     │
│   • No call-filter    → no argument-level constraint                │
│   • No frequency-limit → no invocation rate control                 │
│   • No composite      → cannot combine constraints in 1 policy slot │
└────────────────────────────────────────────────────────────────────┘
```

#### 7.3.5 What Is NOT a Deployable Contract

Confirmed from `Cargo.toml` workspace members:

| Workspace member | Type | Deployed? | In deployment docs? |
|-----------------|------|-----------|-----------------------------|
| `policy-trait` | Library crate (no `#[contract]`) | No | No |
| `spending-limit` | Soroban contract | Yes | Yes (`docs/TESTNET.md`, `docs/MAINNET.md`) |
| `time-bound` | Soroban contract | Yes | Yes |
| `call-filter` | Soroban contract | Yes | Yes |
| `frequency-limit` | Soroban contract | Yes | Yes |
| `composite` | Soroban contract | Yes | Yes |
| `mock-token` | Test fixture | Testnet integration only | No |
| `mock-account` | Test fixture | Testnet integration only | No |

`docs/TESTNET.md` and `docs/MAINNET.md` are generated at the T1 milestone and record
the deployed C-address for each contract on each network.

**Deployable policy contracts: 5. Library crates: 1. Test fixtures: 2.**

### 7.4 Storage Key Architecture

All policies use double-keyed storage with `context_rule.id: u32`:

```rust
// CORRECT — double-keyed, collision-free across all accounts and rules
#[contracttype]
pub enum DataKey {
    Config(Address, u32),    // (smart_account, context_rule.id)
    State(Address, u32),     // (smart_account, context_rule.id) — mutable per-period
}

env.storage().persistent().set(
    &DataKey::Config(smart_account.clone(), context_rule.id),
    &config,
);

// WRONG — single key: collides across accounts / context rules
// env.storage().persistent().set(&DataKey::Config, &config);
```

**Why this matters:** Without double-keying, two different smart accounts using the same policy contract would share state — a critical security bug where account A's spending counter is visible to account B. The `u32` context_rule ID (assigned monotonically by the OZ smart account) guarantees no two active rules on the same account share an ID.

### 7.5 Policy Contract Interaction Diagram

```
OZ Smart Account (call arrives)
         │
         │ 1. scope check: is (contract, fn) in ContextRule scope?
         │    No → panic (scope violation)
         │
         │ 2. signer check: is signer in ContextRule.signers?
         │    No → panic
         │
         │ 3. lifetime check: current_ledger <= ContextRule.valid_until?
         │    Expired → panic
         │
         │ 4. for each policy_address in ContextRule.policies:
         │
         ├─► SpendingLimitPolicy.enforce(context, signers, rule, account)
         │       ├── Load Config(account, rule.id) → {asset, limit, period_secs}
         │       ├── Load State(account, rule.id) → {period_start, spent}
         │       ├── Extract transfer amount from context (SAC transfer args)
         │       ├── Check period reset: if now > period_start + period_secs → reset
         │       ├── Check: spent + amount <= limit  → panic if exceeded
         │       └── Update State: spent += amount
         │
         └─► CallFilterPolicy.enforce(context, signers, rule, account)
                 ├── Load Config(account, rule.id) → {allowed_calls[]}
                 ├── Extract (contract, fn, args) from context
                 └── Check each arg against constraints:
                         ExactAddress → args[i] == expected_address?
                         ExactValue   → args[i] == expected_value?
                         AmountMax    → args[i] as i128 <= max?
                         AmountMin    → args[i] as i128 >= min?
                     Any mismatch → panic (scope violation)
```

---

## 8. AI Integration Architecture

### 8.1 Claude API Integration

```
policy-synthesizer
       │
       ├── Stage 4 (Policy Selection) — prompt construction
       │       Input: RecordedTransaction[], user context
       │       System prompt: Stellar policy expert, OZ trait constraints,
       │                       minimal-scope bias, typed params required
       │       User prompt: call graph, asset flows, observed args
       │
       └── Stage 5 (Code Generation, Layer 2 only)
               Input: PolicyProposal for novel constraints
               System prompt: Soroban Rust expert, no_std, no unsafe,
                               double-keyed storage, overflow-checks = true
               User prompt: constraint description, policy trait signature
               Validation:
                 ✓ No `unsafe` blocks
                 ✓ No bare `panic!` (only env.panic_with_error(PolicyError::*))
                 ✓ Storage key has (Address, u32) double key
                 ✓ Cargo.toml: overflow-checks = true, no_std
```

**Model:** `claude-sonnet-4-6` or later. The synthesizer requires a model with strong Rust code generation and accurate Stellar/Soroban knowledge.

**Synthesis-not-execution principle:** Claude is used to *propose* code and policy configuration. It never submits transactions, never handles private keys, and its output is always reviewed by the user before any on-chain action.

### 8.2 MCP Protocol Integration

```
Claude Code / Claude Desktop / Custom Agent
         │
         │  MCP protocol (JSON-RPC 2.0)
         │
         ├── stdio transport  (local, OZ_POLICY_MCP_HTTP=0)
         │       Client ←─ stdin/stdout ─► mcp-server
         │
         └── HTTP/SSE transport  (remote, OZ_POLICY_MCP_HTTP=1)
                 Client ←─ HTTP POST + Server-Sent Events ─► mcp-server:3000
                 tools/call → POST /mcp
                 tool progress → SSE /mcp/sse

MCP Tool Schema (example):
{
  "name": "synthesize_policy",
  "description": "Synthesize a minimal context rule and policy set from recorded transactions",
  "inputSchema": {
    "type": "object",
    "required": ["session_id", "smart_account_id"],
    "properties": {
      "session_id": {"type": "string"},
      "smart_account_id": {"type": "string", "description": "C-address of the smart account"}
    }
  }
}
```

---

## 9. Security Architecture

### 9.1 Threat Model

```
┌─────────────────────────────────────────────────────────────────────┐
│                      THREAT MODEL                                    │
│                                                                       │
│  Assets to protect:                                                   │
│  • Smart account funds (via policy over-permission)                  │
│  • Policy code correctness (via code injection in AI generation)     │
│  • Transaction integrity (unsigned until user signs)                  │
│                                                                       │
│  Attack surfaces:                                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  A1. Over-broad scope                                         │    │
│  │      Mitigation: scope = exactly observed (contract, fn) set  │    │
│  │      Synthesizer never adds extra pairs                       │    │
│  ├─────────────────────────────────────────────────────────────┤    │
│  │  A2. Over-permissive spending cap                             │    │
│  │      Mitigation: default cap = observed amount; user must    │    │
│  │      explicitly opt-up via clarifying question               │    │
│  ├─────────────────────────────────────────────────────────────┤    │
│  │  A3. Storage key collision (cross-account state leak)         │    │
│  │      Mitigation: all storage double-keyed (account, rule.id) │    │
│  │      Synthesizer validates before emitting code              │    │
│  ├─────────────────────────────────────────────────────────────┤    │
│  │  A4. Unsafe Rust / integer overflow in generated code        │    │
│  │      Mitigation: no unsafe blocks (synthesizer enforces),    │    │
│  │      checked_* arithmetic, overflow-checks = true in Cargo   │    │
│  ├─────────────────────────────────────────────────────────────┤    │
│  │  A5. Auto-deploy without user review                          │    │
│  │      Mitigation: tool NEVER submits tx; outputs unsigned XDR  │    │
│  │      User must explicitly sign and submit                    │    │
│  ├─────────────────────────────────────────────────────────────┤    │
│  │  A6. AI-generated code with backdoors                         │    │
│  │      Mitigation: Layer 1 (templates) for common cases,       │    │
│  │      Layer 2 (AI) only for novel constraints; all output     │    │
│  │      is reviewed before deployment                           │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

### 9.2 Generated Code Safety Invariants

All generated Rust code is validated against these invariants before being returned:

| Invariant | Enforcement | Consequence if violated |
|-----------|------------|-------------------------|
| No `unsafe` blocks | Synthesizer string search + AST | Code rejected, error returned |
| No bare `panic!` macro | Synthesizer validates | Code rejected |
| Storage double-keyed `(Address, u32)` | Pattern matching on DataKey enum | Code rejected |
| `overflow-checks = true` in Cargo.toml | Cargo.toml template enforces | Build-time panic on overflow |
| `#![no_std]` | Template header | Compile error if violated |
| Only `soroban-sdk` imports | Import list scan | Code rejected |

### 9.3 Minimal-Permission Bias

```
For every synthesized policy parameter:

  Spending cap  → observed_amount        (not +10% buffer, not "safe" estimate)
  Scope         → exact_observed_pairs   (not "similar" contracts)
  Arg values    → exact_observed_values  (recipient, path, etc.)
  Lifetime      → asked (not assumed)    (user must confirm)

  User must EXPLICITLY opt-up in response to clarifying questions.
  The synthesizer never opts-up on their behalf.
```

---

## 10. Deployment Architecture

### 10.1 Environment Configuration

```
Environment Variables:
┌─────────────────────────────────────────────────────────────────┐
│  ANTHROPIC_API_KEY        (required) Claude API authentication  │
│  SOROBAN_RPC_URL_TESTNET  (optional) Override default testnet   │
│  SOROBAN_RPC_URL_MAINNET  (optional) Override default mainnet   │
│  OZ_POLICY_MCP_HTTP       (optional) 0=stdio (default), 1=HTTP  │
│  OZ_POLICY_MCP_PORT       (optional) HTTP port (default: 3000)  │
│  OZ_POLICY_SESSION_TTL_MINS (optional) Session TTL (default:60) │
└─────────────────────────────────────────────────────────────────┘
```

### 10.2 Build Pipeline

```
Prerequisites:
  Node.js v22+        (TypeScript packages)
  Rust + Cargo        (Soroban contracts)
  wasm32 target       (rustup target add wasm32-unknown-unknown)

Build steps:
  npm install          → Install TypeScript dependencies
  npm run build        → Compile all TypeScript packages to dist/
  cargo build          → Compile all Rust policy contracts
    --workspace
    --target wasm32-unknown-unknown
    --release

Test steps:
  npm test             → 48 TypeScript tests (codegen, analyzer, mutator)
  cargo test           → 20 Rust contract tests (5 contracts × 4 tests each)
    --workspace
  npm run e2e          → End-to-end pipeline tests

Run:
  npm run mcp          → Start MCP server (stdio mode)
  OZ_POLICY_MCP_HTTP=1 npm run mcp  → Start MCP server (HTTP/SSE mode)
```

### 10.3 Test Coverage

```
┌──────────────────────────────────────────────────────────────┐
│                      TEST MATRIX                              │
│                                                               │
│  TypeScript tests (48 total):                                │
│  ├── codegen/           Code generation from templates        │
│  ├── analyzer/          Invocation tree parsing               │
│  └── mutator/           Deny-case mutation generation         │
│                                                               │
│  Rust tests (20 total, 4 per contract):                       │
│  ├── spending-limit/    permit, deny_exceed, deny_wrong_asset,│
│  │                      period_reset                          │
│  ├── time-bound/        permit, deny_before_start,            │
│  │                      deny_after_end, extend_window         │
│  ├── call-filter/       permit, deny_wrong_arg,               │
│  │                      deny_wrong_contract, amount_max        │
│  ├── frequency-limit/   permit, deny_exceeded,                │
│  │                      window_reset, introspection           │
│  └── composite/         all_pass, one_veto,                   │
│                          cascade_uninstall, max_policies      │
│                                                               │
│  E2E tests (fixtures in tests/fixtures/):                     │
│  ├── Full pipeline: record → synthesize → generate → simulate │
│  └── Three walkthrough scenarios (blend, sep41, soroswap)     │
└──────────────────────────────────────────────────────────────┘
```

### 10.4 Demo Artifacts

The `demo/run-demo.sh` script generates reproducible output in `demo/output/`:

| File | Contents |
|------|----------|
| `typescript-tests.txt` | 48 passing TS test results |
| `rust-tests.txt` | 20 passing Rust contract test results |
| `rust-build.txt` | Clean workspace build output |
| `mcp-tools-manifest.json` | All 8 MCP tools with full inputSchema |
| `mcp-server-health.json` | Live server health response |
| `install-params-xdr.json` | XDR for all 4 typed param structs |
| `wallet-operations-xdr.json` | add_context_rule + add_policy + execute XDRs |
| `codegen-wallet-demo.txt` | Full pipeline console output |
| `generated-contracts-full.txt` | All generated + real contract sources |
| `generated/blend_yield_policy/` | Generated time-bound contract (buildable) |
| `generated/soroswap_dca_policy/` | Generated call-filter contract |
| `generated/sep41_subscription_policy/` | Generated frequency-limit contract |

---

## 11. Error Handling & Failure Modes

### 11.1 Network Failures During Recording

| Failure | Behaviour |
|---------|-----------|
| Horizon unreachable | `recordFromHash` throws `RecorderError.HORIZON_UNAVAILABLE`; session not created |
| Transaction not found (404) | `RecorderError.TX_NOT_FOUND`; caller must verify hash and network |
| Malformed XDR in envelope | `RecorderError.PARSE_FAILED` with the offending operation index |
| Fee-bump inner tx decode error | Outer envelope returned with `feeBumpParseError: true`; inner tx skipped |

All recorder errors are non-retried by default. The MCP `record_transaction` tool returns
`{ ok: false, error: { code, message } }` and leaves the session in `[INIT]` state.

### 11.2 Claude API Failures During Synthesis

| Failure | Behaviour |
|---------|-----------|
| API key missing or invalid | `SynthesizerError.AUTH_FAILED` at startup; server refuses to start |
| Rate limit (429) | Exponential backoff with 3 retries (1s, 4s, 16s); error returned after 3rd failure |
| Context window exceeded | Synthesizer truncates ledger change entries first (lowest signal), then retries |
| Model returns non-JSON | Response discarded; synthesizer falls back to template-only (Layer 1) output |

Layer 1 (Handlebars template) codegen never calls the Claude API and is therefore
immune to API failures. Layer 2 (AI codegen) failures produce a partial result:
the policy proposal is returned without the AI-generated constraint logic, with
`ai_layer_failed: true` in the response so the caller knows to review manually.

### 11.3 Soroban RPC Failures During Simulation

| Failure | Behaviour |
|---------|-----------|
| RPC unreachable | `HarnessError.RPC_UNAVAILABLE`; simulation aborted, partial report returned |
| `simulateTransaction` returns error | Treated as a deny result for permit cases (unexpected deny flagged as issue) |
| Ledger sequence too old | Test transaction rebuilt with current ledger + TTL; single retry |
| Resource exhaustion (instructions exceeded) | Case marked as `RESOURCE_EXCEEDED`, not PASS or FAIL; flagged in report |

The simulation report always returns even on partial failure — `coverage_score` reflects
only the cases that completed. Incomplete cases are listed in `issues[]` with reason
`SIMULATION_ERROR`.

### 11.4 Session Expiry

Sessions are in-memory with a TTL of 1 hour (configurable via `OZ_POLICY_SESSION_TTL_MINS`).

| Scenario | Behaviour |
|----------|-----------|
| Tool call on expired session | `SessionError.EXPIRED`; client must start a new session with `record_transaction` |
| Server restart | All sessions lost; in-memory only by design (no persistence layer) |
| Concurrent tool calls on same session | Last-write-wins on session state; sequential calls are expected by the MCP protocol |

### 11.5 Generated Code Validation Failures

If the synthesizer's post-generation validation rejects AI output (see §9.2 invariants):

| Violation | Behaviour |
|-----------|-----------|
| `unsafe` block detected | Code rejected; `CodegenError.UNSAFE_BLOCK` returned; no file written |
| Bare `panic!` detected | Code rejected; `CodegenError.BARE_PANIC` returned |
| Missing double-key pattern | Code rejected; `CodegenError.STORAGE_KEY_VIOLATION` |
| Any validation failure | Synthesizer retries Layer 2 once with an explicit constraint in the prompt; if second attempt also fails, returns Layer 1 output only with `ai_layer_failed: true` |

---

## Appendix A: Stellar SDK Usage Reference

| SDK Component | Used by | Purpose |
|--------------|---------|---------|
| `Horizon.Server` | tx-recorder | Fetch transaction by hash |
| `SorobanRpc.Server` | tx-recorder, sim-harness | Simulate transactions |
| `xdr.TransactionEnvelope` | tx-recorder | XDR parse/decode |
| `xdr.FeeBumpTransaction` | tx-recorder | Unwrap fee-bump outer tx |
| `xdr.InvokeHostFunctionOp` | tx-recorder | Extract Soroban calls |
| `Asset` | tx-recorder | SAC token identification |
| `TransactionBuilder` | sim-harness | Build test transactions |
| `Operation.invokeHostFunction` | policy-synthesizer | Build install XDRs |

## Appendix B: OZ Accounts On-Chain Addresses

| Network | OZ Smart Account Factory | Status |
|---------|------------------------|--------|
| Stellar Testnet | See [OpenZeppelin Stellar docs](https://docs.openzeppelin.com/stellar) for the current factory address | Active |
| Stellar Mainnet | See [OpenZeppelin Stellar docs](https://docs.openzeppelin.com/stellar) for the current factory address | Active |

The OZ Smart Account factory addresses are maintained by OpenZeppelin and subject to
change with upgrades. Always fetch the current address from the official OZ documentation
rather than hardcoding.

Policy contracts built by this tool are deployed by the developer at the C-address
returned by `soroban contract deploy`. Deployed addresses for each network are recorded
in `docs/TESTNET.md` and `docs/MAINNET.md` at the T1 milestone.

## Appendix C: Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| TypeScript for orchestration | Stellar SDK + Claude API + MCP SDK are all TS-native |
| Rust for contracts | Soroban requires WASM; OZ ecosystem is Rust |
| Template-first codegen | Common cases are always deterministic + auditable |
| AI for novel constraints only | Limits AI blast radius; common case never needs AI |
| In-memory sessions (not DB) | Simplicity; TTL 1h is sufficient for interactive workflow |
| Unsigned XDR output | Never auto-deploy; human always in the loop for on-chain writes |
| `u32` context_rule_id | Monotonic, reuse-safe; assigned by OZ smart account, not developer |
| Double-keyed storage | Prevents cross-account state collision in shared policy contracts |
| `bigint` for amounts | Avoids floating-point rounding on SAC 7-decimal amounts |
