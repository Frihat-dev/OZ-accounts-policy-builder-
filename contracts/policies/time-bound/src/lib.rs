//! Time-Bound Policy — OZ Policy trait compatible.
//!
//! Allows invocations only within a specified ledger sequence range.
//! Conforms to the OZ Accounts policy interface:
//!   install / enforce / uninstall
//!
//! Extra entry-points: can_enforce / get_config
//!
//! Install params (TimeBoundParams):
//!   start_ledger  u32  — first valid ledger sequence (0 = no lower bound)
//!   end_ledger    u32  — last valid ledger sequence (u32::MAX = no upper bound)

#![no_std]

use oz_policy_trait::{policy_panic, ContextRule, PolicyError, Signer};
use soroban_sdk::{auth::Context, contract, contractimpl, contracttype, Address, Env, Vec};

// ── Install params ───────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub struct TimeBoundParams {
    pub start_ledger: u32,
    pub end_ledger: u32,
}

// ── Storage ───────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub struct TimeBoundConfig {
    pub start_ledger: u32,
    pub end_ledger: u32,
}

#[contracttype]
pub enum DataKey {
    Config(Address, u32),
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct TimeBoundPolicy;

#[contractimpl]
impl TimeBoundPolicy {
    // ── OZ Policy interface ───────────────────────────────────────────────────

    pub fn install(
        env: Env,
        install_params: TimeBoundParams,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        if install_params.start_ledger > install_params.end_ledger {
            policy_panic(&env, PolicyError::InvalidConfig);
        }

        let cfg = TimeBoundConfig {
            start_ledger: install_params.start_ledger,
            end_ledger: install_params.end_ledger,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Config(smart_account, context_rule.id), &cfg);
    }

    pub fn enforce(
        env: Env,
        _context: Context,
        _authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        let cfg: TimeBoundConfig = env
            .storage()
            .persistent()
            .get(&DataKey::Config(smart_account, context_rule.id))
            .unwrap_or_else(|| policy_panic(&env, PolicyError::NotInstalled));

        let seq = env.ledger().sequence();
        if seq < cfg.start_ledger || seq > cfg.end_ledger {
            policy_panic(&env, PolicyError::TimeWindowViolation);
        }
    }

    pub fn uninstall(env: Env, context_rule: ContextRule, smart_account: Address) {
        env.storage()
            .persistent()
            .remove(&DataKey::Config(smart_account, context_rule.id));
    }

    // ── Extensions ───────────────────────────────────────────────────────────

    /// Read-only window check — returns false instead of panicking.
    pub fn can_enforce(env: Env, context_rule: ContextRule, smart_account: Address) -> bool {
        let cfg: TimeBoundConfig = match env
            .storage()
            .persistent()
            .get(&DataKey::Config(smart_account, context_rule.id))
        {
            Some(c) => c,
            None => return false,
        };
        let seq = env.ledger().sequence();
        seq >= cfg.start_ledger && seq <= cfg.end_ledger
    }

    /// View: return stored config.
    pub fn get_config(env: Env, context_rule_id: u32, smart_account: Address) -> TimeBoundConfig {
        env.storage()
            .persistent()
            .get(&DataKey::Config(smart_account, context_rule_id))
            .unwrap_or_else(|| policy_panic(&env, PolicyError::NotInstalled))
    }

    /// Admin: extend the policy end ledger (can only push it forward).
    pub fn extend_window(
        env: Env,
        new_end_ledger: u32,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();
        let mut cfg: TimeBoundConfig = env
            .storage()
            .persistent()
            .get(&DataKey::Config(smart_account.clone(), context_rule.id))
            .unwrap_or_else(|| policy_panic(&env, PolicyError::NotInstalled));
        if new_end_ledger <= cfg.end_ledger {
            policy_panic(&env, PolicyError::InvalidConfig);
        }
        cfg.end_ledger = new_end_ledger;
        env.storage()
            .persistent()
            .set(&DataKey::Config(smart_account, context_rule.id), &cfg);
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
            fn_name: symbol_short!("do_thing"),
            args: SoroVec::new(env),
        })
    }

    fn empty_signers(env: &Env) -> SoroVec<Signer> {
        SoroVec::new(env)
    }

    #[test]
    fn allow_within_window() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, TimeBoundPolicy);
        let account = Address::generate(&env);
        let rule = make_rule(&env, 1);

        env.ledger().with_mut(|l| l.sequence_number = 100);

        env.as_contract(&cid, || {
            TimeBoundPolicy::install(
                env.clone(),
                TimeBoundParams { start_ledger: 50, end_ledger: 200 },
                rule.clone(),
                account.clone(),
            );
            assert!(TimeBoundPolicy::can_enforce(env.clone(), rule.clone(), account.clone()));
            TimeBoundPolicy::enforce(
                env.clone(), dummy_context(&env), empty_signers(&env), rule, account,
            );
        });
    }

    #[test]
    fn deny_before_start() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, TimeBoundPolicy);
        let account = Address::generate(&env);
        let rule = make_rule(&env, 1);

        env.ledger().with_mut(|l| l.sequence_number = 10);

        env.as_contract(&cid, || {
            TimeBoundPolicy::install(
                env.clone(),
                TimeBoundParams { start_ledger: 50, end_ledger: 200 },
                rule.clone(),
                account.clone(),
            );
            assert!(!TimeBoundPolicy::can_enforce(env.clone(), rule, account));
        });
    }

    #[test]
    fn deny_after_end() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, TimeBoundPolicy);
        let account = Address::generate(&env);
        let rule = make_rule(&env, 1);

        env.ledger().with_mut(|l| l.sequence_number = 300);

        env.as_contract(&cid, || {
            TimeBoundPolicy::install(
                env.clone(),
                TimeBoundParams { start_ledger: 50, end_ledger: 200 },
                rule.clone(),
                account.clone(),
            );
            assert!(!TimeBoundPolicy::can_enforce(env.clone(), rule, account));
        });
    }

    #[test]
    fn extend_window_pushes_end() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, TimeBoundPolicy);
        let account = Address::generate(&env);
        let rule = make_rule(&env, 1);

        env.ledger().with_mut(|l| l.sequence_number = 100);

        env.as_contract(&cid, || {
            TimeBoundPolicy::install(
                env.clone(),
                TimeBoundParams { start_ledger: 50, end_ledger: 150 },
                rule.clone(),
                account.clone(),
            );
            TimeBoundPolicy::extend_window(
                env.clone(), 300, rule.clone(), account.clone(),
            );
            let cfg = TimeBoundPolicy::get_config(env.clone(), 1, account.clone());
            assert_eq!(cfg.end_ledger, 300);
        });
    }
}
