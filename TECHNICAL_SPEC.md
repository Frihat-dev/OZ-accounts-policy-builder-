# OZ Accounts Policy Builder — Technical Specification

**Version:** 1.0.0  
**Status:** Active  
**Authors:** Senior Engineering Team  
**Date:** 2026-06-09  
**Track:** Stellar RMF — AI / Agent-Readiness & Smart Account Adoption (Q2 2026)

---

## 1. Executive Summary

The OZ Accounts Policy Builder is an AI-assisted developer toolkit that converts observed or simulated Stellar transactions into auditable OpenZeppelin smart account context rules and policy contracts. The primary workflow is: **record → synthesize → simulate → review → deploy**.

The tool never auto-deploys. It generates human-readable, compilable Rust code that the user (or an authorized agent) reviews and deploys as a separate explicit step. This makes it safe to use in agent delegation scenarios: the agent can propose a policy from a sample transaction, but a human (or a separately-authorized deployment agent) must approve it.

---

## 2. Scope

### In Scope
- Transaction recording layer (on-chain by hash + local simulation)
- AI-assisted context rule + policy synthesizer
- Rust code generation for Soroban policy contracts implementing the OZ Policy trait
- MCP server exposing all capabilities to AI agents
- Claude agent skill wrapping the MCP
- Simulation / dry-run harness (permit and deny case testing)
- Integration with OZ-accounts-compatible wallets
- Three documented end-to-end walkthroughs

### Out of Scope
- Hosted deployment service
- On-chain policy registry
- Cross-chain bridging logic
- Managing signer keys or passkeys

---

## 3. Background: OZ Accounts on Stellar

### 3.1 Core Primitives

OpenZeppelin's smart accounts framework for Stellar (Soroban) decomposes authorization into three composable elements:

```
SmartAccount (C-address)
├── Signers[]           — who is authorized to act
├── ContextRules[]      — scope + lifetime bindings
│   ├── scope: Vec<(ContractAddress, FunctionName)>
│   ├── lifetime: LedgerRange | TimestampRange
│   └── policies: Vec<PolicyAddress>  (max 5 per rule)
└── Policies[]          — enforcement modules
    ├── install(smart_account, ctx_rule_id, args)
    ├── can_enforce(smart_account, ctx_rule_id, invocation) → bool
    ├── enforce(smart_account, ctx_rule_id, invocation)
    └── uninstall(smart_account, ctx_rule_id)
```

### 3.2 Policy Lifecycle

```
1. install()     — called once when the context rule is added to the smart account
                   stores initial state keyed by (smart_account, context_rule_id)

2. can_enforce() — called before enforce(); returns false to short-circuit
                   used for cheap read-only guards (e.g. time window check)

3. enforce()     — called for every authorized invocation matching the context rule
                   performs stateful checks and updates (e.g. decrement spending budget)

4. uninstall()   — called when the context rule is removed
                   cleans up storage to recover ledger rent
```

### 3.3 Storage Segregation Rule

Every stateful policy **must** segregate storage by both `smart_account` and `context_rule_id`:

```rust
// CORRECT — double-keyed storage
env.storage().persistent().set(
    &DataKey::State(smart_account.clone(), context_rule_id.clone()),
    &state,
);

// WRONG — collision across accounts/rules
env.storage().persistent().set(&DataKey::State, &state);
```

### 3.4 OZ Standard Primitives (compose-first)

| Primitive | Description | Use when |
|-----------|-------------|----------|
| `simple_threshold` | N-of-N approval threshold | Single signer, basic auth |
| `weighted_threshold` | Weighted multisig | Multi-signer delegation |
| `spending_limit` | Per-period asset spending cap | DeFi delegation, agent budgets |

Composition rule: **always compose existing primitives first; generate net-new contracts only when the required constraint cannot be expressed by combining standard ones.**

---

## 4. Architecture

### 4.1 Component Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        User / AI Agent                          │
└────────────────────┬─────────────────────┬──────────────────────┘
                     │                     │
          ┌──────────▼──────┐    ┌─────────▼──────────┐
          │  Claude Skill   │    │   Direct MCP Call   │
          │  (agent-skill/) │    │                     │
          └──────────┬──────┘    └─────────┬───────────┘
                     │                     │
                     └──────────┬──────────┘
                                │
                   ┌────────────▼────────────┐
                   │       MCP Server        │
                   │    (mcp-server/)        │
                   │                         │
                   │  Tools:                 │
                   │  • record_transaction   │
                   │  • synthesize_policy    │
                   │  • simulate_policy      │
                   │  • generate_code        │
                   │  • verify_policy        │
                   └───┬────────┬────────────┘
                       │        │
          ┌────────────▼──┐  ┌──▼─────────────┐
          │  tx-recorder  │  │policy-synthesizer│
          │               │  │                  │
          │ • Horizon RPC │  │ • Rule builder   │
          │ • Soroban RPC │  │ • Policy selector│
          │ • Tx parser   │  │ • Code generator │
          └───────────────┘  └────────┬─────────┘
                                      │
                             ┌────────▼────────┐
                             │   sim-harness   │
                             │                 │
                             │ • Permit tests  │
                             │ • Deny tests    │
                             │ • Coverage rpt  │
                             └─────────────────┘
                                      │
                    ┌─────────────────▼──────────────────┐
                    │         Soroban RPC / Testnet       │
                    └────────────────────────────────────┘
```

### 4.2 Data Flow

```
1. RECORD
   input:  tx_hash | simulation_envelope
   output: RecordedTransaction {
     invocations: Vec<Invocation>,
     asset_transfers: Vec<AssetTransfer>,
     ledger_changes: Vec<LedgerChange>,
     metadata: TxMetadata,
   }

2. SYNTHESIZE
   input:  RecordedTransaction[] (one or more representative txs)
   output: PolicyProposal {
     context_rule: ContextRuleSpec,
     policies: Vec<PolicySpec>,
     rationale: String,
     questions: Vec<ClarifyingQuestion>,
   }

3. GENERATE CODE
   input:  PolicyProposal (after user answers clarifying questions)
   output: GeneratedCode {
     context_rule_config: Json,
     policy_configs: Vec<PolicyConfig>,   // for OZ standard policies
     policy_contracts: Vec<RustSource>,   // for custom policies
     install_script: String,              // TypeScript install helper
   }

4. SIMULATE
   input:  GeneratedCode + permit_cases + deny_cases
   output: SimulationReport {
     permit_results: Vec<CaseResult>,
     deny_results:   Vec<CaseResult>,
     coverage_score: f64,
     issues: Vec<Issue>,
   }

5. DEPLOY (user-initiated, explicit)
   input:  SimulationReport (approved) + wallet
   output: TxHash (install transaction)
```

---

## 5. Package Specifications

### 5.1 `tx-recorder`

**Language:** TypeScript  
**Runtime:** Node.js ≥ 20

#### Responsibilities
- Fetch a transaction by hash from Stellar Horizon (mainnet or testnet)
- Expand soroban `InvokeHostFunctionOp` envelopes into structured invocation trees
- Accept a Stellar simulation response (XDR or JSON) and produce the same structured output
- Extract: contract addresses, function names, arguments (decoded), SAC token transfers, ledger footprint deltas

#### Key Types

```typescript
interface RecordedTransaction {
  hash: string;
  network: 'mainnet' | 'testnet' | 'simulation';
  ledger: number;
  timestamp: number;
  fee: bigint;
  invocations: Invocation[];
  assetTransfers: AssetTransfer[];
  ledgerChanges: LedgerEntry[];
  rawEnvelope: string; // base64 XDR
}

interface Invocation {
  contractId: string;         // C-address
  contractName?: string;      // resolved from metadata if available
  functionName: string;
  args: InvocationArg[];
  subInvocations: Invocation[];
  success: boolean;
  returnValue?: unknown;
}

interface AssetTransfer {
  assetCode: string;
  issuer?: string;            // undefined for XLM
  from: string;
  to: string;
  amount: bigint;             // in stroops (7 decimals for SAC)
}
```

#### Key Functions

```typescript
async function recordFromHash(
  txHash: string,
  network: Network,
  options?: RecordOptions
): Promise<RecordedTransaction>

async function recordFromSimulation(
  simulationResponse: SorobanRpc.Api.SimulateTransactionResponse,
  envelope: xdr.TransactionEnvelope
): Promise<RecordedTransaction>

async function recordFromXdr(
  envelopeXdr: string,
  network: Network
): Promise<RecordedTransaction>
```

---

### 5.2 `policy-synthesizer`

**Language:** TypeScript  
**Runtime:** Node.js ≥ 20  
**AI Backend:** Claude API (claude-sonnet-4-6 or later)

#### Responsibilities
- Accept one or more `RecordedTransaction` objects
- Infer the minimal context rule (scope + lifetime)
- Select OZ standard policies that cover the observed constraints
- Identify gaps requiring custom policy contracts
- Generate Rust source for custom policies
- Surface clarifying questions before finalizing (e.g. "observed 50 USDC transfer; cap at 50 or allow more?")

#### Synthesis Algorithm

```
1. EXTRACT CALL GRAPH
   - Flatten invocation trees into (contractId, functionName) pairs
   - Deduplicate, preserving all unique pairs
   - This forms the minimum scope for the context rule

2. INFER LIFETIME
   - Default: 1 year from current timestamp
   - If tx has time bounds, use those as hint
   - Always ask user to confirm

3. SELECT ASSET CONSTRAINTS
   - For each AssetTransfer, record (asset, amount, direction)
   - Group by asset: max observed amount = candidate spending limit
   - For recurring flows: infer per-period budget

4. MATCH AGAINST OZ PRIMITIVES
   a. If single signer + no threshold needed → no policy (context rule alone)
   b. If spending bound → spending_limit policy
   c. If multisig required → weighted_threshold policy
   d. If time window → time-bound policy (custom if OZ doesn't have one)
   e. If call frequency limit → frequency-limit policy (custom)
   f. If specific function args must be fixed → call-filter policy (custom)

5. COMPOSE OR GENERATE
   - Compose: configure existing OZ policies with observed params
   - Generate: produce Rust source for custom policies using templates

6. PRODUCE QUESTIONS
   - Any ambiguous parameter → ClarifyingQuestion
   - Examples:
     "Observed 50 USDC; should the spending cap be 50 (exact) or a higher budget?"
     "Transaction executed at 14:00 UTC; should the time window be restricted to business hours?"
```

#### Code Generation Templates

The synthesizer uses a template-based approach for custom policies, with AI completing the per-policy logic:

```
templates/
  spending_limit.rs.hbs   — parameterized spending limit
  time_bound.rs.hbs       — ledger/timestamp time window
  call_filter.rs.hbs      — allowed (contract, function, args) set
  frequency_limit.rs.hbs  — N calls per T seconds
  composite.rs.hbs        — compose multiple sub-policies
```

---

### 5.3 `sim-harness`

**Language:** TypeScript + Soroban RPC  
**Runtime:** Node.js ≥ 20

#### Responsibilities
- Accept generated policy code + context rule spec
- Build permit-case transactions (should be allowed)
- Build deny-case transactions by mutating the permit cases:
  - Different asset
  - Larger amount (above spending limit)
  - Out-of-window timestamp
  - Extra function call not in scope
  - Expired context rule
- Simulate each case against a Soroban node (testnet or local)
- Produce a coverage report

#### Deny Case Mutations

```typescript
type DenyMutation =
  | { type: 'exceed_spending'; factor: number }     // amount * factor
  | { type: 'wrong_asset'; substitute: string }     // different SAC
  | { type: 'out_of_window'; offset: number }       // ledger offset outside valid range
  | { type: 'extra_invocation'; contract: string }  // add unauthorized call
  | { type: 'expired_rule' }                        // set lifetime to past
  | { type: 'wrong_function'; fn: string }          // call unlisted function
```

---

### 5.4 `mcp-server`

**Language:** TypeScript  
**Framework:** `@modelcontextprotocol/sdk`  
**Transport:** stdio (local) + HTTP/SSE (remote)

#### MCP Tools

| Tool | Description |
|------|-------------|
| `record_transaction` | Record a tx by hash or XDR |
| `list_invocations` | List all contract calls in a recorded tx |
| `synthesize_policy` | Synthesize context rule + policies from recorded txs |
| `answer_clarification` | Provide an answer to a clarifying question |
| `generate_code` | Generate Rust policy code from a PolicyProposal |
| `simulate_policy` | Run permit/deny harness against generated code |
| `get_simulation_report` | Fetch simulation report by ID |
| `install_policy` | Build the install transaction XDR (user signs separately) |

#### Tool Input/Output Design

All tools follow the pattern:
```json
{
  "tool": "synthesize_policy",
  "input": { "session_id": "...", "tx_ids": ["..."] },
  "output": {
    "ok": true,
    "data": { ... },
    "questions": [ { "id": "q1", "text": "...", "options": ["50 USDC", "100 USDC", "Custom"] } ]
  }
}
```

Error responses:
```json
{
  "ok": false,
  "error": {
    "code": "TX_NOT_FOUND",
    "message": "Transaction not found on testnet",
    "details": { "hash": "..." }
  }
}
```

#### Session Model

The MCP server maintains ephemeral sessions (in-memory, TTL 1 hour) to correlate multi-step workflows:

```
Session {
  id: string
  recorded_txs: RecordedTransaction[]
  proposal: PolicyProposal | null
  clarifications: Map<string, string>
  generated_code: GeneratedCode | null
  simulation_report: SimulationReport | null
}
```

---

### 5.5 `agent-skill`

**Language:** TypeScript  
**Format:** Claude skill (compatible with Claude Code / Claude API tool use)

#### Skill Entry Points

| Entry | Trigger phrase examples |
|-------|------------------------|
| `record_and_synthesize` | "record this tx and generate a policy" |
| `synthesize_from_description` | "I want to delegate Blend yield claiming" |
| `review_generated_policy` | "review the generated policy for me" |
| `explain_policy` | "what does this policy allow/deny?" |

#### Clarification Logic

The skill knows when to ask vs. when to assume:

```
ALWAYS ASK:
- Spending cap (amount observed vs. budget allowed)
- Lifetime duration (default: 1 year, but surface it)
- Whether to scope to specific argument values or allow any

ASSUME (with rationale in output):
- Scope = exact set of (contract, function) pairs observed
- Direction: cap outbound only (not inbound)
- Per-period reset: weekly for agent delegation, monthly for subscriptions
```

---

## 6. Soroban Policy Contracts

### 6.1 Policy Trait Interface

```rust
// oz_policy_trait/src/lib.rs
pub trait Policy {
    fn install(
        env: Env,
        smart_account: Address,
        context_rule_id: BytesN<32>,
        config: Map<Symbol, Val>,
    );

    fn can_enforce(
        env: Env,
        smart_account: Address,
        context_rule_id: BytesN<32>,
        invocation: AuthInvocation,
    ) -> bool;

    fn enforce(
        env: Env,
        smart_account: Address,
        context_rule_id: BytesN<32>,
        invocation: AuthInvocation,
    );

    fn uninstall(
        env: Env,
        smart_account: Address,
        context_rule_id: BytesN<32>,
    );
}
```

### 6.2 Policy Contracts

| Contract | OZ Equivalent | Description |
|----------|---------------|-------------|
| `spending-limit` | `spending_limit` | Asset spending cap with period reset |
| `time-bound` | Custom | Ledger/timestamp range enforcement |
| `call-filter` | Custom | Allowlist of (contract, function, args) |
| `frequency-limit` | Custom | Max N invocations per time period |
| `composite` | Custom | AND-compose up to 4 sub-policies |

### 6.3 Storage Key Convention

All policies follow this storage key pattern:

```rust
#[contracttype]
pub enum DataKey {
    // Global policy config (set at install, immutable)
    Config(Address, BytesN<32>),     // (smart_account, context_rule_id)
    // Per-period mutable state
    State(Address, BytesN<32>),      // (smart_account, context_rule_id)
}
```

---

## 7. Security Properties

### 7.1 Synthesizer Safety Guarantees
- **Minimal scope**: Generated context rules include only the (contract, function) pairs observed — no extras
- **Bounded amounts**: Default spending cap = observed amount; user must explicitly opt-up
- **Deny-by-default**: Any invocation not matching the context rule scope is denied at the smart account level before policies are even consulted
- **Stateless replay**: Policy code is deterministic given the same inputs; no hidden state

### 7.2 Generated Code Safety
- All generated Rust uses `#![no_std]` and `soroban-sdk` only
- No `unsafe` blocks permitted in generated code (synthesizer enforces this)
- Storage always double-keyed; synthesizer validates this before emitting code
- Overflow checks: all arithmetic uses `checked_*` variants; synthesizer uses `overflow-checks = true` in generated `Cargo.toml`

### 7.3 Audit Plan
- Synthesizer logic and all policy templates will be audited by a Soroban-specialized auditor
- OZ team serves as technical reviewer for generated code quality and primitive composition
- Simulation harness deny-cases are reviewed against the taxonomy of known policy bypass patterns

---

## 8. Wallet Integration

### 8.1 Integration Target
Primary integration: any OZ-accounts-compatible Stellar wallet (e.g. pollywallet, or wallets from C-Address Tooling cohort).

### 8.2 Integration Protocol

```typescript
// The wallet SDK exposes an interface like:
interface OZWalletSDK {
  installContextRule(rule: ContextRuleSpec, policies: PolicySpec[]): Promise<TxHash>;
  listContextRules(account: string): Promise<ContextRule[]>;
  uninstallContextRule(account: string, ruleId: string): Promise<TxHash>;
}

// The policy builder produces a WalletIntegrationBundle:
interface WalletIntegrationBundle {
  contextRuleSpec: ContextRuleSpec;
  policyConfigs: PolicyConfig[];      // for OZ standard policies
  compiledPolicies: CompiledWasm[];   // for custom policies (must be deployed first)
  installTxXdr: string;               // unsigned install transaction
}
```

### 8.3 End-to-End Flow

```
1. User records a transaction in wallet UI → SDK calls record_transaction MCP tool
2. Policy builder synthesizes proposal → surfaces to user in wallet UI
3. User answers clarifying questions in wallet UI
4. Policy builder generates code → user reviews in wallet UI or code editor
5. For custom policies: wallet compiles and deploys policy contract (separate tx)
6. Wallet calls installContextRule with the generated spec
7. User signs and submits the install transaction
```

---

## 9. Three End-to-End Walkthroughs (Summary)

Full walkthroughs are in `docs/walkthroughs/`.

### 9.1 Blend Yield Claim (Blend Protocol)

**Use case:** Delegate yield claiming on Blend to an agent that converts yield to USDC.

Observed transaction sequence:
1. `blend_pool.claim(account, [reserve_token_id], account)` → receive BLEND tokens
2. `router.swap_exact_in(BLEND, USDC, amount, min_out, account, deadline)` → receive USDC

Generated output:
- Context rule scope: `{blend_pool.claim, router.swap_exact_in}`
- Policies: `spending_limit(BLEND, observed_amount)` + `call_filter(only USDC as output)`
- Lifetime: 90 days (typical yield claim delegation)

### 9.2 SEP-41 Subscription Billing

**Use case:** Allow a billing contract to pull a fixed EURC payment monthly.

Observed transaction:
1. `eurc_token.transfer(user, billing_contract, amount)` 

Generated output:
- Context rule scope: `{eurc_token.transfer}`
- Policies: `spending_limit(EURC, amount, period=30d)` + `call_filter(to=billing_contract only)`
- Lifetime: 1 year

### 9.3 Soroswap Bounded Delegation

**Use case:** Allow an agent to trade on Soroswap but with a slippage cap.

Observed transaction:
1. `soroswap_router.swap_exact_tokens_for_tokens(amount_in, min_out, path, to, deadline)`

Generated output:
- Context rule scope: `{soroswap_router.swap_exact_tokens_for_tokens}`
- Policies: `spending_limit(input_token, max_amount_in)` + `call_filter(min_out >= floor)`
- Lifetime: 7 days (short for trading delegation)

---

## 10. Open Questions / Future Work

- Can the synthesizer detect reentrancy risks in the observed call graph? (V2)
- Should the tool support multi-tx sequence policies (e.g. must call A before B)? (V2)
- Upstream useful custom policies back to OZ accounts package (coordination needed)
- Ledger-based vs timestamp-based lifetime: the tool currently prefers timestamp; should it prefer ledger for determinism?
