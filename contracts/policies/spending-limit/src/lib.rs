//! Spending Limit Policy — OZ Policy trait compatible.
//!
//! Enforces a maximum asset transfer amount per rolling time window.
//! Conforms to the OZ Accounts policy interface:
//!   install / enforce / uninstall
//!
//! Extra entry-points (beyond OZ trait):
//!   can_enforce / get_config / get_state / set_limit
//!
//! Install params (SpendingLimitParams):
//!   asset        Address  — SAC token contract to limit
//!   limit        i128     — max cumulative outbound per period (7-decimal)
//!   period_secs  u64      — rolling window length in seconds

#![no_std]

use oz_policy_trait::{policy_panic, ContextRule, PolicyError, Signer};
use soroban_sdk::{
    auth::Context,
    contract, contractimpl, contracttype, symbol_short, Address, Env, Symbol, TryFromVal, Vec,
};

// ── Install params ───────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub struct SpendingLimitParams {
    pub asset: Address,
    pub limit: i128,
    pub period_secs: u64,
}

// ── Storage ───────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub struct SpendingConfig {
    pub asset: Address,
    pub limit: i128,
    pub period_secs: u64,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct SpendingState {
    pub spent: i128,
    pub period_start: u64,
}

#[contracttype]
pub enum DataKey {
    Config(Address, u32),
    State(Address, u32),
}

// ── SAC function names ────────────────────────────────────────────────────────

fn sym_transfer() -> Symbol {
    symbol_short!("transfer")
}
fn sym_transfer_from(env: &Env) -> Symbol {
    Symbol::new(env, "transfer_from")
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct SpendingLimitPolicy;

#[contractimpl]
impl SpendingLimitPolicy {
    // ── OZ Policy interface ───────────────────────────────────────────────────

    /// Install: store config for (smart_account, context_rule.id).
    /// Called by the OZ smart account — no require_auth needed here.
    pub fn install(
        env: Env,
        install_params: SpendingLimitParams,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        if install_params.limit <= 0 {
            policy_panic(&env, PolicyError::InvalidConfig);
        }
        if install_params.period_secs == 0 {
            policy_panic(&env, PolicyError::InvalidConfig);
        }

        let cfg = SpendingConfig {
            asset: install_params.asset,
            limit: install_params.limit,
            period_secs: install_params.period_secs,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Config(smart_account.clone(), context_rule.id), &cfg);

        let state = SpendingState {
            spent: 0,
            period_start: env.ledger().timestamp(),
        };
        env.storage()
            .persistent()
            .set(&DataKey::State(smart_account, context_rule.id), &state);
    }

    /// Enforce: update running spend total; panic if limit exceeded.
    /// Ignores invocations that are not transfers on the configured asset.
    pub fn enforce(
        env: Env,
        context: Context,
        _authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        let cfg: SpendingConfig = env
            .storage()
            .persistent()
            .get(&DataKey::Config(smart_account.clone(), context_rule.id))
            .unwrap_or_else(|| policy_panic(&env, PolicyError::NotInstalled));

        let amount = match extract_amount(&env, &context, &cfg) {
            Some(a) => a,
            None => return, // not a tracked transfer, pass through
        };

        let mut state: SpendingState = env
            .storage()
            .persistent()
            .get(&DataKey::State(smart_account.clone(), context_rule.id))
            .unwrap_or_else(|| policy_panic(&env, PolicyError::NotInstalled));

        let now = env.ledger().timestamp();
        if now >= state.period_start.saturating_add(cfg.period_secs) {
            state.period_start = now;
            state.spent = 0;
        }

        let new_spent = state
            .spent
            .checked_add(amount)
            .filter(|&s| s <= cfg.limit)
            .unwrap_or_else(|| policy_panic(&env, PolicyError::SpendingLimitExceeded));
        state.spent = new_spent;

        env.storage()
            .persistent()
            .set(&DataKey::State(smart_account, context_rule.id), &state);
    }

    /// Uninstall: remove all storage for this (account, rule) pair.
    pub fn uninstall(env: Env, context_rule: ContextRule, smart_account: Address) {
        env.storage()
            .persistent()
            .remove(&DataKey::Config(smart_account.clone(), context_rule.id));
        env.storage()
            .persistent()
            .remove(&DataKey::State(smart_account, context_rule.id));
    }

    // ── Extensions: simulation & management ──────────────────────────────────

    /// Read-only enforce check — returns false instead of panicking.
    pub fn can_enforce(
        env: Env,
        context: Context,
        context_rule: ContextRule,
        smart_account: Address,
    ) -> bool {
        let cfg: SpendingConfig = match env
            .storage()
            .persistent()
            .get(&DataKey::Config(smart_account.clone(), context_rule.id))
        {
            Some(c) => c,
            None => return false,
        };

        let amount = match extract_amount(&env, &context, &cfg) {
            Some(a) => a,
            None => return true, // not a tracked transfer — allowed
        };

        let state: SpendingState = match env
            .storage()
            .persistent()
            .get(&DataKey::State(smart_account, context_rule.id))
        {
            Some(s) => s,
            None => return false,
        };

        let now = env.ledger().timestamp();
        let spent = if now >= state.period_start.saturating_add(cfg.period_secs) {
            0_i128
        } else {
            state.spent
        };

        spent.checked_add(amount).map(|s| s <= cfg.limit).unwrap_or(false)
    }

    /// View: return stored config.
    pub fn get_config(env: Env, context_rule_id: u32, smart_account: Address) -> SpendingConfig {
        env.storage()
            .persistent()
            .get(&DataKey::Config(smart_account, context_rule_id))
            .unwrap_or_else(|| policy_panic(&env, PolicyError::NotInstalled))
    }

    /// View: return current spend state.
    pub fn get_state(env: Env, context_rule_id: u32, smart_account: Address) -> SpendingState {
        env.storage()
            .persistent()
            .get(&DataKey::State(smart_account, context_rule_id))
            .unwrap_or_else(|| policy_panic(&env, PolicyError::NotInstalled))
    }

    /// Admin: update the spending cap without reinstalling.
    /// The smart account must authorize this call.
    pub fn set_limit(
        env: Env,
        new_limit: i128,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();
        if new_limit <= 0 {
            policy_panic(&env, PolicyError::InvalidConfig);
        }
        let mut cfg: SpendingConfig = env
            .storage()
            .persistent()
            .get(&DataKey::Config(smart_account.clone(), context_rule.id))
            .unwrap_or_else(|| policy_panic(&env, PolicyError::NotInstalled));
        cfg.limit = new_limit;
        env.storage()
            .persistent()
            .set(&DataKey::Config(smart_account, context_rule.id), &cfg);
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn extract_amount(env: &Env, context: &Context, cfg: &SpendingConfig) -> Option<i128> {
    let ctx = match context {
        Context::Contract(c) => c,
        _ => return None,
    };
    if ctx.contract != cfg.asset {
        return None;
    }
    let is_transfer = ctx.fn_name == sym_transfer();
    let is_transfer_from = ctx.fn_name == sym_transfer_from(env);
    if !is_transfer && !is_transfer_from {
        return None;
    }
    // transfer(from, to, amount) → amount at index 2
    // transfer_from(spender, from, to, amount) → amount at index 3
    let idx: u32 = if is_transfer { 2 } else { 3 };
    ctx.args
        .get(idx)
        .and_then(|v| i128::try_from_val(env, &v).ok())
        .filter(|&a| a > 0)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use oz_policy_trait::{ContextRuleType, Signer};
    use soroban_sdk::{
        auth::ContractContext,
        testutils::{Address as _, Ledger},
        Env, IntoVal, String as SoroString, Vec as SoroVec,
    };

    fn make_rule(env: &Env, id: u32) -> ContextRule {
        ContextRule {
            id,
            context_type: ContextRuleType::Default,
            name: SoroString::from_str(env, "test"),
            signers: SoroVec::new(env),
            signer_ids: SoroVec::new(env),
            policies: SoroVec::new(env),
            policy_ids: SoroVec::new(env),
            valid_until: None,
        }
    }

    fn transfer_ctx(env: &Env, asset: &Address, from: &Address, to: &Address, amount: i128) -> Context {
        Context::Contract(ContractContext {
            contract: asset.clone(),
            fn_name: symbol_short!("transfer"),
            args: soroban_sdk::vec![
                env,
                from.clone().into_val(env),
                to.clone().into_val(env),
                amount.into_val(env),
            ],
        })
    }

    fn empty_signers(env: &Env) -> SoroVec<Signer> {
        SoroVec::new(env)
    }

    #[test]
    fn install_and_enforce_within_limit() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, SpendingLimitPolicy);
        let account = Address::generate(&env);
        let asset = Address::generate(&env);
        let rule = make_rule(&env, 1);

        env.as_contract(&cid, || {
            SpendingLimitPolicy::install(
                env.clone(),
                SpendingLimitParams { asset: asset.clone(), limit: 1000, period_secs: 86400 },
                rule.clone(),
                account.clone(),
            );

            let ctx = transfer_ctx(&env, &asset, &account, &Address::generate(&env), 500);
            assert!(SpendingLimitPolicy::can_enforce(
                env.clone(), ctx.clone(), rule.clone(), account.clone()
            ));
            SpendingLimitPolicy::enforce(
                env.clone(), ctx, empty_signers(&env), rule.clone(), account.clone(),
            );

            let state = SpendingLimitPolicy::get_state(env.clone(), 1, account.clone());
            assert_eq!(state.spent, 500);
        });
    }

    #[test]
    fn enforce_rejects_over_limit() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, SpendingLimitPolicy);
        let account = Address::generate(&env);
        let asset = Address::generate(&env);
        let recip = Address::generate(&env);
        let rule = make_rule(&env, 1);

        env.as_contract(&cid, || {
            SpendingLimitPolicy::install(
                env.clone(),
                SpendingLimitParams { asset: asset.clone(), limit: 100, period_secs: 86400 },
                rule.clone(),
                account.clone(),
            );
            // Spend 60
            let ctx1 = transfer_ctx(&env, &asset, &account, &recip, 60);
            SpendingLimitPolicy::enforce(
                env.clone(), ctx1, empty_signers(&env), rule.clone(), account.clone(),
            );
            // can_enforce should return false for 60 more (total 120 > 100)
            let ctx2 = transfer_ctx(&env, &asset, &account, &recip, 60);
            assert!(!SpendingLimitPolicy::can_enforce(
                env.clone(), ctx2, rule.clone(), account.clone()
            ));
        });
    }

    #[test]
    fn period_rollover_resets_budget() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, SpendingLimitPolicy);
        let account = Address::generate(&env);
        let asset = Address::generate(&env);
        let recip = Address::generate(&env);
        let rule = make_rule(&env, 1);

        env.as_contract(&cid, || {
            SpendingLimitPolicy::install(
                env.clone(),
                SpendingLimitParams { asset: asset.clone(), limit: 100, period_secs: 86400 },
                rule.clone(),
                account.clone(),
            );
            let ctx = transfer_ctx(&env, &asset, &account, &recip, 100);
            SpendingLimitPolicy::enforce(
                env.clone(), ctx, empty_signers(&env), rule.clone(), account.clone(),
            );
        });

        env.ledger().with_mut(|l| l.timestamp += 86401);

        env.as_contract(&cid, || {
            let ctx = transfer_ctx(&env, &asset, &account, &recip, 100);
            assert!(SpendingLimitPolicy::can_enforce(
                env.clone(), ctx, rule.clone(), account.clone()
            ));
        });
    }

    #[test]
    fn uninstall_cleans_storage() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, SpendingLimitPolicy);
        let account = Address::generate(&env);
        let asset = Address::generate(&env);
        let rule = make_rule(&env, 1);

        env.as_contract(&cid, || {
            SpendingLimitPolicy::install(
                env.clone(),
                SpendingLimitParams { asset: asset.clone(), limit: 100, period_secs: 86400 },
                rule.clone(),
                account.clone(),
            );
        });
        env.as_contract(&cid, || {
            SpendingLimitPolicy::uninstall(env.clone(), rule.clone(), account.clone());
            let cfg: Option<SpendingConfig> =
                env.storage().persistent().get(&DataKey::Config(account.clone(), 1));
            assert!(cfg.is_none());
        });
    }

    #[test]
    fn non_asset_context_passes_through() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, SpendingLimitPolicy);
        let account = Address::generate(&env);
        let asset = Address::generate(&env);
        let other = Address::generate(&env);
        let rule = make_rule(&env, 1);

        env.as_contract(&cid, || {
            SpendingLimitPolicy::install(
                env.clone(),
                SpendingLimitParams { asset: asset.clone(), limit: 1, period_secs: 86400 },
                rule.clone(),
                account.clone(),
            );
            // Call to a different contract — should pass regardless of limit
            let ctx = Context::Contract(ContractContext {
                contract: other.clone(),
                fn_name: symbol_short!("transfer"),
                args: soroban_sdk::vec![
                    &env,
                    account.clone().into_val(&env),
                    other.clone().into_val(&env),
                    99999_i128.into_val(&env),
                ],
            });
            assert!(SpendingLimitPolicy::can_enforce(
                env.clone(), ctx.clone(), rule.clone(), account.clone()
            ));
            SpendingLimitPolicy::enforce(
                env.clone(), ctx, empty_signers(&env), rule, account,
            );
        });
    }
}
