//! Call Filter Policy — OZ Policy trait compatible.
//!
//! Enforces an allowlist of (contract, function) pairs with optional
//! typed argument constraints (address, amount range, or exact value).
//! Conforms to the OZ Accounts policy interface:
//!   install / enforce / uninstall
//!
//! Extra entry-points: can_enforce / get_config
//!
//! Install params (CallFilterParams):
//!   allowed_calls  Vec<AllowedCall>  — allowlist entries
//!
//! Constraint types (ArgConstraint):
//!   ExactAddress(position, address)   — arg at position must equal address
//!   ExactValue(position, i128)        — arg at position must equal integer
//!   AmountMax(position, i128)         — arg at position must be <= max
//!   AmountMin(position, i128)         — arg at position must be >= min

#![no_std]

use oz_policy_trait::{policy_panic, ContextRule, PolicyError, Signer};
use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contractimpl, contracttype, Address, Env, TryFromVal, Vec,
};

// ── Types ─────────────────────────────────────────────────────────────────────

/// Richer argument constraint — supports address match and amount bounds.
/// This exceeds pollywallet's simple address-only constraints.
#[contracttype]
#[derive(Clone, Debug)]
pub enum ArgConstraint {
    /// Arg at position must be exactly this address.
    ExactAddress(u32, Address),
    /// Arg at position must equal this i128 value.
    ExactValue(u32, i128),
    /// Arg at position (numeric) must be <= max.
    AmountMax(u32, i128),
    /// Arg at position (numeric) must be >= min.
    AmountMin(u32, i128),
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct AllowedCall {
    pub contract: Address,
    pub fn_name: soroban_sdk::Symbol,
    pub arg_constraints: Vec<ArgConstraint>,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct CallFilterParams {
    pub allowed_calls: Vec<AllowedCall>,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct CallFilterConfig {
    pub allowed_calls: Vec<AllowedCall>,
}

#[contracttype]
pub enum DataKey {
    Config(Address, u32),
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct CallFilterPolicy;

#[contractimpl]
impl CallFilterPolicy {
    // ── OZ Policy interface ───────────────────────────────────────────────────

    pub fn install(
        env: Env,
        install_params: CallFilterParams,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        if install_params.allowed_calls.is_empty() {
            policy_panic(&env, PolicyError::InvalidConfig);
        }
        let cfg = CallFilterConfig { allowed_calls: install_params.allowed_calls };
        env.storage()
            .persistent()
            .set(&DataKey::Config(smart_account, context_rule.id), &cfg);
    }

    pub fn enforce(
        env: Env,
        context: Context,
        _authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        let cfg: CallFilterConfig = env
            .storage()
            .persistent()
            .get(&DataKey::Config(smart_account, context_rule.id))
            .unwrap_or_else(|| policy_panic(&env, PolicyError::NotInstalled));

        if !is_allowed(&env, &cfg, &context) {
            policy_panic(&env, PolicyError::ScopeViolation);
        }
    }

    pub fn uninstall(env: Env, context_rule: ContextRule, smart_account: Address) {
        env.storage()
            .persistent()
            .remove(&DataKey::Config(smart_account, context_rule.id));
    }

    // ── Extensions ───────────────────────────────────────────────────────────

    /// Read-only allowlist check — returns false instead of panicking.
    pub fn can_enforce(
        env: Env,
        context: Context,
        context_rule: ContextRule,
        smart_account: Address,
    ) -> bool {
        let cfg: CallFilterConfig = match env
            .storage()
            .persistent()
            .get(&DataKey::Config(smart_account, context_rule.id))
        {
            Some(c) => c,
            None => return false,
        };
        is_allowed(&env, &cfg, &context)
    }

    /// View: return stored config.
    pub fn get_config(env: Env, context_rule_id: u32, smart_account: Address) -> CallFilterConfig {
        env.storage()
            .persistent()
            .get(&DataKey::Config(smart_account, context_rule_id))
            .unwrap_or_else(|| policy_panic(&env, PolicyError::NotInstalled))
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn is_allowed(env: &Env, cfg: &CallFilterConfig, context: &Context) -> bool {
    let ctx: &ContractContext = match context {
        Context::Contract(c) => c,
        _ => return false,
    };

    for i in 0..cfg.allowed_calls.len() {
        let allowed = cfg.allowed_calls.get(i).unwrap();
        if allowed.contract != ctx.contract {
            continue;
        }
        if allowed.fn_name != ctx.fn_name {
            continue;
        }
        if constraints_pass(env, &allowed.arg_constraints, ctx) {
            return true;
        }
    }
    false
}

fn constraints_pass(env: &Env, constraints: &Vec<ArgConstraint>, ctx: &ContractContext) -> bool {
    for i in 0..constraints.len() {
        let constraint = constraints.get(i).unwrap();
        match constraint {
            ArgConstraint::ExactAddress(pos, required) => {
                let actual = match ctx.args.get(pos) {
                    Some(v) => v,
                    None => return false,
                };
                let addr = match Address::try_from_val(env, &actual) {
                    Ok(a) => a,
                    Err(_) => return false,
                };
                if addr != required {
                    return false;
                }
            }
            ArgConstraint::ExactValue(pos, required) => {
                let actual = match ctx.args.get(pos) {
                    Some(v) => v,
                    None => return false,
                };
                let val = match i128::try_from_val(env, &actual) {
                    Ok(v) => v,
                    Err(_) => return false,
                };
                if val != required {
                    return false;
                }
            }
            ArgConstraint::AmountMax(pos, max) => {
                let actual = match ctx.args.get(pos) {
                    Some(v) => v,
                    None => return false,
                };
                let val = match i128::try_from_val(env, &actual) {
                    Ok(v) => v,
                    Err(_) => return false,
                };
                if val > max {
                    return false;
                }
            }
            ArgConstraint::AmountMin(pos, min) => {
                let actual = match ctx.args.get(pos) {
                    Some(v) => v,
                    None => return false,
                };
                let val = match i128::try_from_val(env, &actual) {
                    Ok(v) => v,
                    Err(_) => return false,
                };
                if val < min {
                    return false;
                }
            }
        }
    }
    true
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use oz_policy_trait::{ContextRuleType, Signer};
    use soroban_sdk::{
        auth::ContractContext,
        symbol_short,
        testutils::Address as _,
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

    fn empty_signers(env: &Env) -> SoroVec<Signer> {
        SoroVec::new(env)
    }

    fn no_constraints(env: &Env) -> SoroVec<ArgConstraint> {
        SoroVec::new(env)
    }

    #[test]
    fn allow_matching_call() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, CallFilterPolicy);
        let account = Address::generate(&env);
        let target = Address::generate(&env);
        let rule = make_rule(&env, 1);

        env.as_contract(&cid, || {
            let allowed = AllowedCall {
                contract: target.clone(),
                fn_name: symbol_short!("transfer"),
                arg_constraints: no_constraints(&env),
            };
            CallFilterPolicy::install(
                env.clone(),
                CallFilterParams { allowed_calls: soroban_sdk::vec![&env, allowed] },
                rule.clone(),
                account.clone(),
            );

            let ctx = Context::Contract(ContractContext {
                contract: target.clone(),
                fn_name: symbol_short!("transfer"),
                args: SoroVec::new(&env),
            });
            assert!(CallFilterPolicy::can_enforce(
                env.clone(), ctx.clone(), rule.clone(), account.clone()
            ));
            CallFilterPolicy::enforce(env.clone(), ctx, empty_signers(&env), rule, account);
        });
    }

    #[test]
    fn deny_unlisted_contract() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, CallFilterPolicy);
        let account = Address::generate(&env);
        let target = Address::generate(&env);
        let other = Address::generate(&env);
        let rule = make_rule(&env, 1);

        env.as_contract(&cid, || {
            let allowed = AllowedCall {
                contract: target.clone(),
                fn_name: symbol_short!("transfer"),
                arg_constraints: no_constraints(&env),
            };
            CallFilterPolicy::install(
                env.clone(),
                CallFilterParams { allowed_calls: soroban_sdk::vec![&env, allowed] },
                rule.clone(),
                account.clone(),
            );

            let ctx = Context::Contract(ContractContext {
                contract: other,
                fn_name: symbol_short!("transfer"),
                args: SoroVec::new(&env),
            });
            assert!(!CallFilterPolicy::can_enforce(env.clone(), ctx, rule, account));
        });
    }

    #[test]
    fn amount_max_constraint_enforced() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, CallFilterPolicy);
        let account = Address::generate(&env);
        let target = Address::generate(&env);
        let rule = make_rule(&env, 1);

        env.as_contract(&cid, || {
            // transfer(from, to, amount) — constrain amount (index 2) to <= 500
            let constraint = ArgConstraint::AmountMax(2, 500);
            let allowed = AllowedCall {
                contract: target.clone(),
                fn_name: symbol_short!("transfer"),
                arg_constraints: soroban_sdk::vec![&env, constraint],
            };
            CallFilterPolicy::install(
                env.clone(),
                CallFilterParams { allowed_calls: soroban_sdk::vec![&env, allowed] },
                rule.clone(),
                account.clone(),
            );

            // Amount 300 ≤ 500 → allowed
            let from = Address::generate(&env);
            let to = Address::generate(&env);
            let ok_ctx = Context::Contract(ContractContext {
                contract: target.clone(),
                fn_name: symbol_short!("transfer"),
                args: soroban_sdk::vec![
                    &env,
                    from.clone().into_val(&env),
                    to.clone().into_val(&env),
                    300_i128.into_val(&env),
                ],
            });
            assert!(CallFilterPolicy::can_enforce(
                env.clone(), ok_ctx, rule.clone(), account.clone()
            ));

            // Amount 1000 > 500 → denied
            let bad_ctx = Context::Contract(ContractContext {
                contract: target.clone(),
                fn_name: symbol_short!("transfer"),
                args: soroban_sdk::vec![
                    &env,
                    from.into_val(&env),
                    to.into_val(&env),
                    1000_i128.into_val(&env),
                ],
            });
            assert!(!CallFilterPolicy::can_enforce(
                env.clone(), bad_ctx, rule, account
            ));
        });
    }

    #[test]
    fn exact_address_constraint_enforced() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, CallFilterPolicy);
        let account = Address::generate(&env);
        let target = Address::generate(&env);
        let required_recipient = Address::generate(&env);
        let other_recipient = Address::generate(&env);
        let rule = make_rule(&env, 1);

        env.as_contract(&cid, || {
            // transfer(from, to, amount) — constrain to (index 1) to required_recipient
            let constraint = ArgConstraint::ExactAddress(1, required_recipient.clone());
            let allowed = AllowedCall {
                contract: target.clone(),
                fn_name: symbol_short!("transfer"),
                arg_constraints: soroban_sdk::vec![&env, constraint],
            };
            CallFilterPolicy::install(
                env.clone(),
                CallFilterParams { allowed_calls: soroban_sdk::vec![&env, allowed] },
                rule.clone(),
                account.clone(),
            );

            let from = account.clone();
            // Correct recipient → allowed
            let ok_ctx = Context::Contract(ContractContext {
                contract: target.clone(),
                fn_name: symbol_short!("transfer"),
                args: soroban_sdk::vec![
                    &env,
                    from.clone().into_val(&env),
                    required_recipient.clone().into_val(&env),
                    100_i128.into_val(&env),
                ],
            });
            assert!(CallFilterPolicy::can_enforce(
                env.clone(), ok_ctx, rule.clone(), account.clone()
            ));

            // Wrong recipient → denied
            let bad_ctx = Context::Contract(ContractContext {
                contract: target.clone(),
                fn_name: symbol_short!("transfer"),
                args: soroban_sdk::vec![
                    &env,
                    from.into_val(&env),
                    other_recipient.into_val(&env),
                    100_i128.into_val(&env),
                ],
            });
            assert!(!CallFilterPolicy::can_enforce(
                env.clone(), bad_ctx, rule, account
            ));
        });
    }
}
