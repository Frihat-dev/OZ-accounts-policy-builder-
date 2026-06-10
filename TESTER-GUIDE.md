# OZ Policy Builder — Tester Guide

This document explains what was built, how it differs from the reference
implementation (pollywallet), and how to verify every artifact without running
code.

---

## What was built

A full Soroban policy system for OZ (OpenZeppelin) Smart Accounts on Stellar
that is **wire-compatible with the real `stellar-accounts` policy trait**:

```
install(params, context_rule, account)
enforce(context, signers, context_rule, account)
uninstall(context_rule, account)
can_enforce(context, context_rule, account) -> bool   ← our extension
```

Five deployed policy contracts, a code-generator, a transaction recorder, and
a wallet integration module.  All types (`ContextRule`, `Signer`,
`ContextRuleType`, `Context`) match the live OZ interface.

---

## Quick verification

```bash
# Rust: 20 contract tests
~/.cargo/bin/cargo test --workspace

# TypeScript: 48 codegen / analyzer / mutator tests
npm test

# MCP server health (if running)
curl http://localhost:3000/health
```

Expected output: all tests pass, `{"ok":true,"transport":"http-sse"}`.

---

## Artifacts in `demo/output/`

| File | What it proves |
|------|---------------|
| `typescript-tests.txt` | 48 TS tests pass: codegen emits OZ-compatible Rust |
| `rust-tests.txt` | 20 Rust tests pass across 5 policy contracts |
| `rust-build.txt` | Workspace compiles clean (no errors) |
| `mcp-tools-manifest.json` | All 8 MCP tools with full `inputSchema` |
| `mcp-server-health.json` | Live server health response |
| `mcp-server.log` | Server startup log |
| `install-params-xdr.json` | XDR-encoded install params for all 4 typed structs |
| `wallet-operations-xdr.json` | `add_context_rule` + `add_policy` + `execute` op XDRs |
| `codegen-wallet-demo.txt` | Console output of the full Option 3 demo run |
| `generated-contracts-full.txt` | All 3 generated + 7 real contract sources in one file |
| `generated/blend_yield_policy/` | Generated time-bound contract (ready to `cargo build`) |
| `generated/soroswap_dca_policy/` | Generated call-filter contract |
| `generated/sep41_subscription_policy/` | Generated frequency-limit contract |

---

## Policy contracts

All in `contracts/policies/`:

### spending-limit
- `SpendingLimitParams { asset, limit, period_secs }`
- Tracks `spent` per `(account, rule_id)` pair; resets after `period_secs`
- Non-asset-contract invocations pass through unconditionally
- 5 tests: within-limit, over-limit, period rollover, uninstall, non-asset pass-through

### time-bound
- `TimeBoundParams { start_ledger, end_ledger }`
- Panics outside the window with `PolicyError::NotYetActive` / `PolicyError::Expired`
- Admin-only `extend_window()` (can only push `end_ledger` forward)
- 4 tests: allow_within_window, deny_before_start, deny_after_end, extend_window

### call-filter
- `CallFilterParams { allowed_calls: Vec<AllowedCall> }`
- `AllowedCall { contract, fn_name, arg_constraints: Vec<ArgConstraint> }`
- **Richer than pollywallet**: 4 constraint types vs 1
  - `ExactAddress(position, addr)` — argument must equal a specific address
  - `ExactValue(position, i128)` — argument must equal an exact integer
  - `AmountMax(position, i128)` — argument (amount) ≤ max
  - `AmountMin(position, i128)` — argument (amount) ≥ min
- 4 tests: allow matching call, deny unlisted contract, amount_max, exact_address

### frequency-limit
- `FrequencyLimitParams { max_calls, window_secs }`
- Per-`(account, rule_id)` call counter with window reset
- `get_state()` introspection endpoint
- 3 tests: within limit, reset after window, get_state tracking

### composite
- `CompositeParams { sub_policies: Vec<Address> }`
- **MAX_SUB_POLICIES = 8** (vs pollywallet's 4)
- Delegates full 5-arg `enforce` and 3-arg `can_enforce` to each sub-policy
- Any sub-policy returning `can_enforce = false` short-circuits the whole rule
- 4 tests: all-allow, deny-if-any-denies, enforce-cascades, uninstall-removes-config

---

## Code generator (`packages/policy-synthesizer/src/codegen.ts`)

Three generators emit OZ-compatible Rust:
- `generateTimeBoundSource(spec)` → `RustPolicySource`
- `generateCallFilterSource(spec)` → `RustPolicySource`
- `generateFrequencyLimitSource(spec)` → `RustPolicySource`

**Every generated contract**:
- Is `#![no_std]`
- Imports from `oz_policy_trait` (`ContextRule`, `PolicyError`, `Signer`, `policy_panic`)
- Uses `DataKey::Config(Address, u32)` / `DataKey::State(Address, u32)`
- Has no `AuthInvocation`, `EnforceDecision`, `BytesN<32>`, `Map<Symbol, Val>`
- Includes all 4 lifecycle functions (`install`, `enforce`, `uninstall`, `can_enforce`)

---

## Wallet integration (`packages/policy-synthesizer/src/wallet.ts`)

```typescript
buildAddContextRuleTx(params)         // → { addContextRuleXdr, addPolicyXdrTemplate }
patchAddPolicyRuleId(xdr, ruleId)     // substitute actual rule_id after add_context_rule
buildPolicyExecuteTx(params)          // → execute(target, fn, args) op XDR
submitViaRelayer(opXdr, key, config)  // POST /v1/relay to OZ Channels
waitForTransaction(hash, rpc, ms)     // poll Soroban RPC getTransaction
encodeTimeBoundParams(start, end)     // → base64 XDR
encodeSpendingLimitParams(asset, amt, period)
encodeFrequencyLimitParams(max, secs)
encodeCallFilterParams(calls)
```

---

## Transaction recorder (`packages/tx-recorder/src/recorder.ts`)

Additions beyond the base recorder:
- **Fee-bump envelope support**: unwraps `envelopeTypeTxFeeBump` to inner v1 tx
- **Auth tree traversal**: populates `subInvocations` from `SorobanAuthorizationEntry[]`
- **OZ execute() decomposition**: detects `execute(target, fn, args)` and injects a
  synthetic child invocation so the policy synthesizer sees the real call target
- **U128, U64, U32, I32 ScVal decoding**
- `scAddressToStrKey` falls back to `StrKey.encodeContract` for raw 32-byte IDs

---

## How this beats pollywallet

| Dimension | pollywallet | oz-policy-builder |
|-----------|-------------|-------------------|
| Policy interface | custom (BytesN<32> key, Map<Symbol,Val> params) | real OZ trait |
| Storage key | `BytesN<32>` hash | `context_rule.id: u32` |
| Install params | untyped map | typed structs per policy |
| ArgConstraint types | address-only | ExactAddress + ExactValue + AmountMax + AmountMin |
| Composite max sub-policies | 4 | 8 |
| Fee-bump support in recorder | no | yes |
| Auth tree traversal | no | yes |
| execute() decomposition | no | yes |
| Wallet XDR builder | none | full (add_context_rule, add_policy, execute, relayer) |
| Code generator | basic | OZ-compatible, all 4 lifecycle fns, typed params |

---

## Re-running the full demo

```bash
cd ~/oz-policy-builder
bash demo/run-demo.sh
```

Outputs land in `demo/output/`. The MCP server stays running at
`http://localhost:3000` after the script exits.

To connect an MCP client to the live server:

```bash
# HTTP/SSE endpoint
GET  http://localhost:3000/mcp
POST http://localhost:3000/messages
```
