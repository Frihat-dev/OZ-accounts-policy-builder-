# Walkthrough 3: Soroswap Bounded Trading Delegation

**Use case:** Let an AI trading agent execute swaps on Soroswap, but with a bounded weekly budget and a minimum output constraint (slippage cap).

**Involved protocol:** Soroswap DEX router

---

## 1. Scenario

You hold XLM and want an agent to DCA (dollar-cost average) into USDC on a weekly basis. The agent should:

- Swap up to 100 XLM per week into USDC
- Never accept worse than 2% slippage (min_out ≥ 98% of expected)
- Only trade on the XLM→USDC route
- Only for the next 4 weeks (trial period)

---

## 2. Observed Transaction

You perform one manual swap as the sample:

```json
{
  "invocations": [
    {
      "contract": "CSOROSWAP_ROUTER...",
      "function": "swap_exact_tokens_for_tokens",
      "args": [
        { "type": "number", "value": "250000000", "comment": "amount_in: 25 XLM" },
        { "type": "number", "value": "245000000", "comment": "amount_out_min: 24.5 USDC (2% slip)" },
        { "type": "vec", "value": ["CXLM_SAC...", "CUSDC_TOKEN..."], "comment": "path" },
        { "type": "address", "value": "CACCOUNT_USER...", "comment": "recipient" },
        { "type": "number", "value": "1748200000", "comment": "deadline" }
      ]
    }
  ],
  "asset_transfers": [
    { "asset": "XLM", "from": "CACCOUNT_USER...", "to": "CSOROSWAP_ROUTER...", "amount": "250000000" },
    { "asset": "USDC", "from": "CSOROSWAP_ROUTER...", "to": "CACCOUNT_USER...", "amount": "246500000" }
  ]
}
```

---

## 3. Policy Synthesis

### Context Rule

```json
{
  "label": "Soroswap XLM→USDC DCA — 100 XLM/week",
  "scope": [
    { "contractId": "CSOROSWAP_ROUTER...", "functionName": "swap_exact_tokens_for_tokens" }
  ],
  "lifetime": {
    "type": "duration_seconds",
    "durationSeconds": 2419200,
    "description": "28 days (4 weeks) from installation"
  }
}
```

### Proposed Policies

1. **OZ Spending Limit — XLM** (standard OZ)
   - Limit: 1,000,000,000 (100 XLM) per 604,800 seconds (7 days)
   - Derived from observed amount × 4 (user wants 4× headroom for weekly batching)

2. **Custom Call Filter** (generated Rust)
   - Locks the swap path to `[XLM, USDC]`
   - Locks the recipient to `CACCOUNT_USER` (funds always return to owner)

3. **Custom Frequency Limit** (generated Rust)
   - Max 10 swaps per 24-hour window
   - Prevents runaway agent making micro-swaps

### Clarifying Questions

> Q1: "Observed 25 XLM in one swap. Should the weekly budget be 25 XLM (one swap) or 100 XLM (to allow multiple)?"
> → User: "100 XLM per week — the agent should run multiple times"

> Q2: "Should swaps be limited to XLM→USDC only, or any pair?"
> → User: "XLM→USDC only"

> Q3: "Should the agent be able to do unlimited swaps per day, or cap at N?"
> → User: "Max 5 swaps per day (to prevent churning)"

> Q4: "How long should this delegation run?"
> → User: "4 weeks — this is a trial"

---

## 4. Generated Code

### Config (standard OZ spending limit)

```json
{
  "kind": "oz_spending_limit",
  "config": {
    "assetContractId": "CXLM_SAC...",
    "limitAmount": "1000000000",
    "periodSeconds": 604800
  }
}
```

### Custom Call Filter (Rust)

```rust
//! Generated Call Filter — Soroswap DCA
//! Enforces: only XLM→USDC path, recipient == owner

fn is_allowed(env: &Env, cfg: &CallFilterConfig, inv: &AuthInvocation) -> bool {
    // Must be router's swap function
    if inv.contract != SOROSWAP_ROUTER || inv.function != sym!("swap_exact_t") {
        return false;
    }
    
    // path arg (index 2) must be [XLM, USDC]
    if let Some(path) = get_path_arg(inv) {
        if path.len() != 2 { return false; }
        if path[0] != XLM_SAC { return false; }
        if path[1] != USDC_TOKEN { return false; }
    }
    
    // recipient (index 3) must be the smart account owner
    if let Some(recipient) = get_recipient_arg(inv) {
        return recipient == OWNER_ADDRESS;
    }
    
    false
}
```

### Custom Frequency Limit (Rust)

```rust
//! Generated Frequency Limit — max 5 swaps per 24 hours
const MAX_CALLS: u32 = 5_u32;
const WINDOW_SECS: u64 = 86400_u64;
// ... standard template body ...
```

---

## 5. Simulation Results

```
Permit cases (2 txs recorded):
  ✓ 25 XLM → USDC swap (within limits)
  ✓ 40 XLM → USDC swap (within limits)

Deny cases:
  ✓ deny-exceed-spend:      101 XLM weekly spend denied
  ✓ deny-wrong-path:        XLM→BLEND instead of XLM→USDC denied
  ✓ deny-wrong-recipient:   swap output to attacker address denied
  ✓ deny-wrong-fn:          withdraw() denied (not in scope)
  ✓ deny-extra-invocation:  drain_funds() added to call sequence denied
  ✓ deny-exceed-frequency:  6th swap in same day denied
  ✓ deny-expired-rule:      swap after 4 weeks denied

Coverage score: 100%
```

---

## 6. Why Three Policies?

| Policy | What it prevents |
|--------|-----------------|
| Spending limit (100 XLM/week) | Agent draining the full XLM balance |
| Call filter (path + recipient) | Swapping to wrong asset or sending output elsewhere |
| Frequency limit (5/day) | Runaway agent making hundreds of micro-swaps |

Any two of the three alone would leave a gap. The spending limit alone doesn't prevent wrong-path swaps. The call filter alone doesn't cap total weekly spend. The frequency limit alone doesn't cap the amount per swap. Together, they tightly bound the agent's action space.

---

## 7. Slippage Enforcement Note

The current policy set does **not** enforce a minimum `amount_out_min` argument value — that would require a custom policy reading the third argument and comparing it against a floor. This is a V2 feature.

Interim mitigation: the call filter could add an `ArgConstraint` on argument index 1 (`amount_out_min`) requiring it to be ≥ a floor value. This requires knowing the expected market price at policy install time, which makes it stale after price movements.

Recommended approach for production: use the frequency limit + spending limit as the primary safety bounds, and rely on the agent itself to set a reasonable `amount_out_min` in each swap. The policy ensures the agent can't exceed its budget even if it accepts bad slippage.
