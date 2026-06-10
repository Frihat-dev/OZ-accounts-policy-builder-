//! Frequency Limit Policy — OZ Policy trait compatible.
//!
//! Allows at most N invocations per rolling time window.
//! Conforms to the OZ Accounts policy interface:
//!   install / enforce / uninstall
//!
//! Extra entry-points: can_enforce / get_config / get_state
//!
//! Install params (FrequencyLimitParams):
//!   max_calls    u32  — maximum number of calls allowed per window
//!   window_secs  u64  — rolling window length in seconds

#![no_std]

use oz_policy_trait::{policy_panic, ContextRule, PolicyError, Signer};
use soroban_sdk::{auth::Context, contract, contractimpl, contracttype, Address, Env, Vec};

// ── Install params ───────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub struct FrequencyLimitParams {
    pub max_calls: u32,
    pub window_secs: u64,
}

// ── Storage ───────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub struct FrequencyConfig {
    pub max_calls: u32,
    pub window_secs: u64,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct FrequencyState {
    pub call_count: u32,
    pub window_start: u64,
}

#[contracttype]
pub enum DataKey {
    Config(Address, u32),
    State(Address, u32),
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct FrequencyLimitPolicy;

#[contractimpl]
impl FrequencyLimitPolicy {
    // ── OZ Policy interface ───────────────────────────────────────────────────

    pub fn install(
        env: Env,
        install_params: FrequencyLimitParams,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        if install_params.max_calls == 0 {
            policy_panic(&env, PolicyError::InvalidConfig);
        }
        if install_params.window_secs == 0 {
            policy_panic(&env, PolicyError::InvalidConfig);
        }

        let cfg = FrequencyConfig {
            max_calls: install_params.max_calls,
            window_secs: install_params.window_secs,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Config(smart_account.clone(), context_rule.id), &cfg);

        let state = FrequencyState {
            call_count: 0,
            window_start: env.ledger().timestamp(),
        };
        env.storage()
            .persistent()
            .set(&DataKey::State(smart_account, context_rule.id), &state);
    }

    pub fn enforce(
        env: Env,
        _context: Context,
        _authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        let cfg: FrequencyConfig = env
            .storage()
            .persistent()
            .get(&DataKey::Config(smart_account.clone(), context_rule.id))
            .unwrap_or_else(|| policy_panic(&env, PolicyError::NotInstalled));

        let mut state: FrequencyState = env
            .storage()
            .persistent()
            .get(&DataKey::State(smart_account.clone(), context_rule.id))
            .unwrap_or_else(|| policy_panic(&env, PolicyError::NotInstalled));

        let now = env.ledger().timestamp();
        if now >= state.window_start.saturating_add(cfg.window_secs) {
            state.window_start = now;
            state.call_count = 0;
        }

        if state.call_count >= cfg.max_calls {
            policy_panic(&env, PolicyError::FrequencyLimitExceeded);
        }

        state.call_count = state
            .call_count
            .checked_add(1)
            .unwrap_or_else(|| policy_panic(&env, PolicyError::FrequencyLimitExceeded));

        env.storage()
            .persistent()
            .set(&DataKey::State(smart_account, context_rule.id), &state);
    }

    pub fn uninstall(env: Env, context_rule: ContextRule, smart_account: Address) {
        env.storage()
            .persistent()
            .remove(&DataKey::Config(smart_account.clone(), context_rule.id));
        env.storage()
            .persistent()
            .remove(&DataKey::State(smart_account, context_rule.id));
    }

    // ── Extensions ───────────────────────────────────────────────────────────

    /// Read-only window check — returns false instead of panicking.
    pub fn can_enforce(env: Env, context_rule: ContextRule, smart_account: Address) -> bool {
        let cfg: FrequencyConfig = match env
            .storage()
            .persistent()
            .get(&DataKey::Config(smart_account.clone(), context_rule.id))
        {
            Some(c) => c,
            None => return false,
        };
        let state: FrequencyState = match env
            .storage()
            .persistent()
            .get(&DataKey::State(smart_account, context_rule.id))
        {
            Some(s) => s,
            None => return false,
        };
        let now = env.ledger().timestamp();
        let count = if now >= state.window_start.saturating_add(cfg.window_secs) {
            0_u32
        } else {
            state.call_count
        };
        count < cfg.max_calls
    }

    /// View: return stored config.
    pub fn get_config(env: Env, context_rule_id: u32, smart_account: Address) -> FrequencyConfig {
        env.storage()
            .persistent()
            .get(&DataKey::Config(smart_account, context_rule_id))
            .unwrap_or_else(|| policy_panic(&env, PolicyError::NotInstalled))
    }

    /// View: return current call state.
    pub fn get_state(env: Env, context_rule_id: u32, smart_account: Address) -> FrequencyState {
        env.storage()
            .persistent()
            .get(&DataKey::State(smart_account, context_rule_id))
            .unwrap_or_else(|| policy_panic(&env, PolicyError::NotInstalled))
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use oz_policy_trait::{ContextRuleType, Signer};
    use soroban_sdk::{
        auth::{Context, ContractContext},
        symbol_short,
        testutils::{Address as _, Ledger},
        Env, String as SoroString, Vec as SoroVec,
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

    fn dummy_context(env: &Env) -> Context {
        Context::Contract(ContractContext {
            contract: Address::generate(env),
            fn_name: symbol_short!("fn"),
            args: SoroVec::new(env),
        })
    }

    fn empty_signers(env: &Env) -> SoroVec<Signer> {
        SoroVec::new(env)
    }

    #[test]
    fn allows_up_to_limit() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, FrequencyLimitPolicy);
        let account = Address::generate(&env);
        let rule = make_rule(&env, 1);

        env.as_contract(&cid, || {
            FrequencyLimitPolicy::install(
                env.clone(),
                FrequencyLimitParams { max_calls: 3, window_secs: 3600 },
                rule.clone(),
                account.clone(),
            );

            for _ in 0..3 {
                assert!(FrequencyLimitPolicy::can_enforce(
                    env.clone(), rule.clone(), account.clone()
                ));
                FrequencyLimitPolicy::enforce(
                    env.clone(), dummy_context(&env), empty_signers(&env), rule.clone(), account.clone(),
                );
            }

            // 4th call should be denied
            assert!(!FrequencyLimitPolicy::can_enforce(
                env.clone(), rule.clone(), account.clone()
            ));
        });
    }

    #[test]
    fn resets_after_window() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, FrequencyLimitPolicy);
        let account = Address::generate(&env);
        let rule = make_rule(&env, 1);

        env.as_contract(&cid, || {
            FrequencyLimitPolicy::install(
                env.clone(),
                FrequencyLimitParams { max_calls: 1, window_secs: 3600 },
                rule.clone(),
                account.clone(),
            );
            FrequencyLimitPolicy::enforce(
                env.clone(), dummy_context(&env), empty_signers(&env), rule.clone(), account.clone(),
            );
            // Denied immediately after
            assert!(!FrequencyLimitPolicy::can_enforce(
                env.clone(), rule.clone(), account.clone()
            ));
        });

        env.ledger().with_mut(|l| l.timestamp += 3601);

        env.as_contract(&cid, || {
            assert!(FrequencyLimitPolicy::can_enforce(
                env.clone(), rule, account
            ));
        });
    }

    #[test]
    fn get_state_tracks_count() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, FrequencyLimitPolicy);
        let account = Address::generate(&env);
        let rule = make_rule(&env, 1);

        env.as_contract(&cid, || {
            FrequencyLimitPolicy::install(
                env.clone(),
                FrequencyLimitParams { max_calls: 5, window_secs: 3600 },
                rule.clone(),
                account.clone(),
            );
            FrequencyLimitPolicy::enforce(
                env.clone(), dummy_context(&env), empty_signers(&env), rule.clone(), account.clone(),
            );
            FrequencyLimitPolicy::enforce(
                env.clone(), dummy_context(&env), empty_signers(&env), rule.clone(), account.clone(),
            );
            let state = FrequencyLimitPolicy::get_state(env.clone(), 1, account.clone());
            assert_eq!(state.call_count, 2);
        });
    }
}
