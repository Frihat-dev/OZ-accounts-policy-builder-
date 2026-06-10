//! Minimal smart account stub for policy integration tests.
//! Simulates the OZ smart account's policy dispatch loop using the real OZ types.

#![no_std]

use oz_policy_trait::{ContextRule, Signer};
use soroban_sdk::{
    auth::Context, contract, contractimpl, contracttype, Address, Env, IntoVal, Symbol, Vec,
};

#[contracttype]
pub enum DataKey {
    Policies(u32), // context_rule.id → Vec<Address>
}

#[contract]
pub struct MockSmartAccount;

#[contractimpl]
impl MockSmartAccount {
    /// Register policies for a context rule id.
    pub fn set_policies(env: Env, context_rule_id: u32, policies: Vec<Address>) {
        env.storage()
            .persistent()
            .set(&DataKey::Policies(context_rule_id), &policies);
    }

    /// Simulate the smart account's authorization check:
    /// calls can_enforce on all policies (returns false immediately on deny),
    /// then enforce on all (which panics if any sub-policy rejects).
    pub fn authorize(
        env: Env,
        account: Address,
        context_rule: ContextRule,
        context: Context,
        signers: Vec<Signer>,
    ) -> bool {
        let policies: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::Policies(context_rule.id))
            .unwrap_or(Vec::new(&env));

        // Phase 1: can_enforce (read-only pre-check)
        for i in 0..policies.len() {
            let policy = policies.get(i).unwrap();
            let allowed: bool = env.invoke_contract(
                &policy,
                &Symbol::new(&env, "can_enforce"),
                soroban_sdk::vec![
                    &env,
                    context.clone().into_val(&env),
                    context_rule.clone().into_val(&env),
                    account.clone().into_val(&env),
                ],
            );
            if !allowed {
                return false;
            }
        }

        // Phase 2: enforce (state-mutating)
        for i in 0..policies.len() {
            let policy = policies.get(i).unwrap();
            env.invoke_contract::<()>(
                &policy,
                &Symbol::new(&env, "enforce"),
                soroban_sdk::vec![
                    &env,
                    context.clone().into_val(&env),
                    signers.clone().into_val(&env),
                    context_rule.clone().into_val(&env),
                    account.clone().into_val(&env),
                ],
            );
        }

        true
    }
}
