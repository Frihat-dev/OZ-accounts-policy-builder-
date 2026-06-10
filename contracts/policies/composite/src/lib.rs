//! Composite Policy — OZ Policy trait compatible.
//!
//! AND-composes up to 8 sub-policies. All sub-policies must permit an invocation
//! for it to proceed. Allows stacking constraints (e.g. time-bound AND spending-limit).
//! Conforms to the OZ Accounts policy interface:
//!   install / enforce / uninstall
//!
//! Extra entry-points: can_enforce / get_config
//!
//! Install params (CompositeParams):
//!   sub_policies  Vec<Address>  — addresses of deployed sub-policy contracts
//!
//! Sub-policies must already be installed before installing this composite.
//! Uninstall cascades to each sub-policy.

#![no_std]

use oz_policy_trait::{policy_panic, ContextRule, PolicyError, Signer};
use soroban_sdk::{
    auth::Context, contract, contractimpl, contracttype, Address, Env, IntoVal, Symbol, Vec,
};

const MAX_SUB_POLICIES: u32 = 8;

// ── Install params ───────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub struct CompositeParams {
    pub sub_policies: Vec<Address>,
}

// ── Storage ───────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub struct CompositeConfig {
    pub sub_policies: Vec<Address>,
}

#[contracttype]
pub enum DataKey {
    Config(Address, u32),
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct CompositePolicy;

#[contractimpl]
impl CompositePolicy {
    // ── OZ Policy interface ───────────────────────────────────────────────────

    pub fn install(
        env: Env,
        install_params: CompositeParams,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        if install_params.sub_policies.is_empty() {
            policy_panic(&env, PolicyError::InvalidConfig);
        }
        if install_params.sub_policies.len() > MAX_SUB_POLICIES {
            policy_panic(&env, PolicyError::InvalidConfig);
        }

        let cfg = CompositeConfig { sub_policies: install_params.sub_policies };
        env.storage()
            .persistent()
            .set(&DataKey::Config(smart_account, context_rule.id), &cfg);
    }

    pub fn enforce(
        env: Env,
        context: Context,
        authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        let cfg: CompositeConfig = env
            .storage()
            .persistent()
            .get(&DataKey::Config(smart_account.clone(), context_rule.id))
            .unwrap_or_else(|| policy_panic(&env, PolicyError::NotInstalled));

        for i in 0..cfg.sub_policies.len() {
            let sub = cfg.sub_policies.get(i).unwrap();
            call_sub_enforce(
                &env,
                &sub,
                context.clone(),
                authenticated_signers.clone(),
                context_rule.clone(),
                smart_account.clone(),
            );
        }
    }

    pub fn uninstall(env: Env, context_rule: ContextRule, smart_account: Address) {
        if let Some(cfg) = env
            .storage()
            .persistent()
            .get::<_, CompositeConfig>(&DataKey::Config(smart_account.clone(), context_rule.id))
        {
            for i in 0..cfg.sub_policies.len() {
                let sub = cfg.sub_policies.get(i).unwrap();
                call_sub_uninstall(&env, &sub, context_rule.clone(), smart_account.clone());
            }
        }

        env.storage()
            .persistent()
            .remove(&DataKey::Config(smart_account, context_rule.id));
    }

    // ── Extensions ───────────────────────────────────────────────────────────

    /// Read-only check: returns false if ANY sub-policy's can_enforce returns false.
    pub fn can_enforce(
        env: Env,
        context: Context,
        context_rule: ContextRule,
        smart_account: Address,
    ) -> bool {
        let cfg: CompositeConfig = match env
            .storage()
            .persistent()
            .get(&DataKey::Config(smart_account.clone(), context_rule.id))
        {
            Some(c) => c,
            None => return false,
        };

        for i in 0..cfg.sub_policies.len() {
            let sub = cfg.sub_policies.get(i).unwrap();
            let allowed: bool = call_sub_can_enforce(
                &env,
                &sub,
                context.clone(),
                context_rule.clone(),
                smart_account.clone(),
            );
            if !allowed {
                return false;
            }
        }
        true
    }

    /// View: return stored config.
    pub fn get_config(env: Env, context_rule_id: u32, smart_account: Address) -> CompositeConfig {
        env.storage()
            .persistent()
            .get(&DataKey::Config(smart_account, context_rule_id))
            .unwrap_or_else(|| policy_panic(&env, PolicyError::NotInstalled))
    }
}

// ── Cross-contract calls to sub-policies ─────────────────────────────────────

fn call_sub_enforce(
    env: &Env,
    sub: &Address,
    context: Context,
    signers: Vec<Signer>,
    rule: ContextRule,
    account: Address,
) {
    env.invoke_contract::<()>(
        sub,
        &Symbol::new(env, "enforce"),
        soroban_sdk::vec![
            env,
            context.into_val(env),
            signers.into_val(env),
            rule.into_val(env),
            account.into_val(env),
        ],
    );
}

fn call_sub_uninstall(env: &Env, sub: &Address, rule: ContextRule, account: Address) {
    env.invoke_contract::<()>(
        sub,
        &Symbol::new(env, "uninstall"),
        soroban_sdk::vec![
            env,
            rule.into_val(env),
            account.into_val(env),
        ],
    );
}

fn call_sub_can_enforce(
    env: &Env,
    sub: &Address,
    context: Context,
    rule: ContextRule,
    account: Address,
) -> bool {
    env.invoke_contract(
        sub,
        &Symbol::new(env, "can_enforce"),
        soroban_sdk::vec![
            env,
            context.into_val(env),
            rule.into_val(env),
            account.into_val(env),
        ],
    )
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// Each mock must be in its own submodule: #[contractimpl] emits module-level
// symbols that collide when two impl blocks share the same Rust module scope.

#[cfg(test)]
mod mock_allow {
    use oz_policy_trait::{ContextRule, Signer};
    use soroban_sdk::{auth::Context, contract, contractimpl, Address, Env, Vec};

    #[contract]
    pub struct AlwaysAllow;

    #[contractimpl]
    impl AlwaysAllow {
        pub fn install(_env: Env, _params: super::CompositeParams, _rule: ContextRule, _account: Address) {}
        pub fn enforce(_env: Env, _ctx: Context, _signers: Vec<Signer>, _rule: ContextRule, _account: Address) {}
        pub fn uninstall(_env: Env, _rule: ContextRule, _account: Address) {}
        pub fn can_enforce(_env: Env, _ctx: Context, _rule: ContextRule, _account: Address) -> bool { true }
    }
}

#[cfg(test)]
mod mock_deny {
    use oz_policy_trait::{policy_panic, ContextRule, PolicyError, Signer};
    use soroban_sdk::{auth::Context, contract, contractimpl, Address, Env, Vec};

    #[contract]
    pub struct AlwaysDeny;

    #[contractimpl]
    impl AlwaysDeny {
        pub fn install(_env: Env, _params: super::CompositeParams, _rule: ContextRule, _account: Address) {}
        pub fn enforce(env: Env, _ctx: Context, _signers: Vec<Signer>, _rule: ContextRule, _account: Address) {
            policy_panic(&env, PolicyError::ScopeViolation)
        }
        pub fn uninstall(_env: Env, _rule: ContextRule, _account: Address) {}
        pub fn can_enforce(_env: Env, _ctx: Context, _rule: ContextRule, _account: Address) -> bool { false }
    }
}

#[cfg(test)]
mod tests {
    use super::{mock_allow::AlwaysAllow, mock_deny::AlwaysDeny, *};
    use oz_policy_trait::{ContextRuleType, Signer};
    use soroban_sdk::{
        auth::{Context, ContractContext},
        symbol_short,
        testutils::Address as _,
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

    fn install_with_subs(
        env: &Env,
        cid: &Address,
        account: &Address,
        rule: &ContextRule,
        subs: Vec<Address>,
    ) {
        env.as_contract(cid, || {
            CompositePolicy::install(
                env.clone(),
                CompositeParams { sub_policies: subs },
                rule.clone(),
                account.clone(),
            );
        });
    }

    #[test]
    fn can_enforce_all_allow() {
        let env = Env::default();
        env.mock_all_auths();

        let sub1 = env.register_contract(None, AlwaysAllow);
        let sub2 = env.register_contract(None, AlwaysAllow);
        let cid = env.register_contract(None, CompositePolicy);
        let account = Address::generate(&env);
        let rule = make_rule(&env, 1);

        install_with_subs(&env, &cid, &account, &rule, soroban_sdk::vec![&env, sub1, sub2]);

        env.as_contract(&cid, || {
            assert!(CompositePolicy::can_enforce(
                env.clone(), dummy_context(&env), rule.clone(), account.clone()
            ));
        });
    }

    #[test]
    fn can_enforce_deny_if_any_sub_denies() {
        let env = Env::default();
        env.mock_all_auths();

        let allow_id = env.register_contract(None, AlwaysAllow);
        let deny_id = env.register_contract(None, AlwaysDeny);
        let cid = env.register_contract(None, CompositePolicy);
        let account = Address::generate(&env);
        let rule = make_rule(&env, 1);

        install_with_subs(&env, &cid, &account, &rule, soroban_sdk::vec![&env, allow_id, deny_id]);

        env.as_contract(&cid, || {
            assert!(!CompositePolicy::can_enforce(
                env.clone(), dummy_context(&env), rule.clone(), account.clone()
            ));
        });
    }

    #[test]
    fn enforce_cascades_to_all_subs() {
        let env = Env::default();
        env.mock_all_auths();

        let sub1 = env.register_contract(None, AlwaysAllow);
        let sub2 = env.register_contract(None, AlwaysAllow);
        let cid = env.register_contract(None, CompositePolicy);
        let account = Address::generate(&env);
        let rule = make_rule(&env, 1);

        install_with_subs(&env, &cid, &account, &rule, soroban_sdk::vec![&env, sub1, sub2]);

        env.as_contract(&cid, || {
            CompositePolicy::enforce(
                env.clone(), dummy_context(&env), empty_signers(&env), rule, account,
            );
        });
    }

    #[test]
    fn uninstall_removes_config() {
        let env = Env::default();
        env.mock_all_auths();

        let sub1 = env.register_contract(None, AlwaysAllow);
        let cid = env.register_contract(None, CompositePolicy);
        let account = Address::generate(&env);
        let rule = make_rule(&env, 1);

        install_with_subs(&env, &cid, &account, &rule, soroban_sdk::vec![&env, sub1]);

        env.as_contract(&cid, || {
            CompositePolicy::uninstall(env.clone(), rule.clone(), account.clone());
            let cfg: Option<CompositeConfig> = env
                .storage()
                .persistent()
                .get(&DataKey::Config(account.clone(), 1));
            assert!(cfg.is_none());
        });
    }
}
