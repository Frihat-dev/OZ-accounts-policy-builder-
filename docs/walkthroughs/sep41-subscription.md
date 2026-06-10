# Walkthrough 2: SEP-41 Subscription Billing

**Use case:** Allow a SaaS billing contract to pull a fixed EURC payment from your smart account once per month, without any other access.

**Involved protocol:** Any SEP-41 compatible token (EURC in this example)

---

## 1. Scenario

You subscribe to a Stellar-native service that charges 10 EURC/month. Rather than signing a transaction every month, you want to install a context rule that lets the billing contract call `transfer()` on your behalf — but only:

- From your account to the billing contract address
- For exactly 10 EURC (or up to 10 EURC)
- At most once per 30-day period
- For a maximum of 12 months (1 year)

This is the Stellar-native equivalent of a recurring payment authorization.

---

## 2. Observed Transaction

Record a payment you already made:

```bash
{ "tool": "record_transaction", "input": { "tx_hash": "b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6", "network": "testnet" } }
```

Extracted:

```json
{
  "invocations": [
    {
      "contract": "CEURC_TOKEN_CONTRACT...",
      "function": "transfer",
      "args": [
        { "type": "address", "value": "CACCOUNT_USER..." },
        { "type": "address", "value": "CBILLING_CONTRACT..." },
        { "type": "number", "value": "100000000" }
      ]
    }
  ],
  "asset_transfers": [
    {
      "asset": "EURC",
      "issuer": "GCURRENCY_ISSUER...",
      "from": "CACCOUNT_USER...",
      "to": "CBILLING_CONTRACT...",
      "amount": "100000000"
    }
  ]
}
```

(100,000,000 base units = 10 EURC at 7 decimals)

---

## 3. Policy Synthesis

The synthesizer observes:
- One function call: `CEURC_TOKEN::transfer`
- One recipient: `CBILLING_CONTRACT` (fixed, always the same)
- Amount: 100,000,000 (10 EURC)

### Context Rule

```json
{
  "label": "Monthly EURC Subscription — 10 EURC/month",
  "scope": [
    { "contractId": "CEURC_TOKEN_CONTRACT...", "functionName": "transfer" }
  ],
  "lifetime": {
    "type": "duration_seconds",
    "durationSeconds": 31536000,
    "description": "1 year from installation"
  }
}
```

### Proposed Policies

1. **OZ Spending Limit — EURC** (standard OZ)
   - Limit: 100,000,000 per 2,592,000 seconds (30 days)
   - Prevents over-billing within a month

2. **Custom Call Filter** (generated Rust)
   - Function: `transfer` on EURC token only
   - Arg constraint: `to` (arg[1]) must equal `CBILLING_CONTRACT`
   - Prevents the billing contract from routing funds to any other address

### Clarifying Questions

> Q1: "The observed transfer was 10 EURC. Should the monthly cap be exactly 10 EURC, or allow flexibility?"
> → User: "10 EURC exactly. No overages."

> Q2: "The recipient was CBILLING_CONTRACT. Should I pin this to that exact address?"
> → User: "Yes — only that address."

> Q3: "How many months should this subscription run?"
> → User: "12 months (1 year)"

---

## 4. Generated Code

### Spending Limit Config (standard OZ — no compilation)

```json
{
  "kind": "oz_spending_limit",
  "config": {
    "assetContractId": "CEURC_TOKEN_CONTRACT...",
    "limitAmount": "100000000",
    "periodSeconds": 2592000
  }
}
```

### Call Filter (Rust — must compile + deploy)

```rust
//! Generated Call Filter — Monthly EURC Subscription
//! Locks transfer() to CBILLING_CONTRACT as the only allowed recipient.

#![no_std]
// ... standard boilerplate ...

// Core enforcement:
//   invocation.contract == CEURC_TOKEN
//   invocation.function == "transfer"
//   invocation.args[1] (recipient) == CBILLING_CONTRACT
```

### Install Script

```typescript
const contextRuleConfig = {
  label: "Monthly EURC Subscription — 10 EURC/month",
  scope: [{ contractId: "CEURC_TOKEN_CONTRACT...", functionName: "transfer" }],
  lifetimeSeconds: 31536000,
  policyAddresses: [
    "COZ_SPENDING_LIMIT_DEPLOYED...",
    "CCALL_FILTER_DEPLOYED..."
  ]
};

await wallet.installContextRule(contextRuleConfig);
```

---

## 5. Simulation Results

```
Permit cases: 1/1 passed  ✓ (monthly payment of 10 EURC to billing contract)

Deny cases:
  ✓ deny-exceed-spend:    10× amount denied (100 EURC in a month)
  ✓ deny-wrong-recipient: Transfer to attacker address denied
  ✓ deny-wrong-asset:     USDC transfer denied (only EURC in scope)
  ✓ deny-expired-rule:    After 1 year, all transfers denied
  ✓ deny-extra-call:      Adding an extra transfer call denied

Coverage score: 100%
```

---

## 6. What the Billing Protocol Sees

When the billing contract initiates the monthly charge, it invokes `transfer()` on the EURC token. The smart account:

1. Checks scope: `CEURC_TOKEN::transfer` ✓ (in the context rule)
2. Calls `can_enforce()` on spending limit: 10 EURC ≤ monthly cap ✓
3. Calls `can_enforce()` on call filter: recipient == CBILLING_CONTRACT ✓
4. Calls `enforce()` on both policies (updates state)
5. Authorizes the transfer

If the billing contract tries to charge twice in a month, the spending limit's `can_enforce()` returns `Deny` and the transfer is rejected at the smart account level.

---

## 7. Security Properties

| Threat | Mitigation |
|--------|-----------|
| Over-billing (more than 10 EURC/month) | Spending limit: 100M per 30 days |
| Billing to wrong address | Call filter: recipient pinned to billing contract |
| Charging in wrong asset | Scope: only `CEURC_TOKEN::transfer` |
| Perpetual billing after cancellation | Lifetime: uninstall context rule to cancel |
| Double-billing in same month | Period reset logic in spending limit |
