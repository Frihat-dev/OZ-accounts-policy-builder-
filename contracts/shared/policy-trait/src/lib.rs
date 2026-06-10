//! OZ Policy Trait — shared types for all policy contracts.
//!
//! Types here **must** match the OZ Accounts smart account contract exactly.
//! The ContextRule, Signer, and ContextRuleType definitions are copied from
//! the OZ accounts package so that policy contracts interoperate with live
//! OZ smart accounts on Stellar without any adapter layer.
//!
//! Reference: kalepail/pollywallet CORE_TYPES_SOURCE + stellar-accounts crate.

#![no_std]

use soroban_sdk::{contracterror, contracttype, Address, Bytes, BytesN, Env, String, Vec};

// ── OZ Smart Account compatible types ──────────────────────────────────────
// IMPORTANT: these must be binary-compatible with the live OZ smart account
// contract on Stellar. Do not rename fields or change variant order.

/// A signer authorised to act under a context rule.
/// Delegated: a funded Stellar account (G…).
/// External:  a verifier contract + raw public key (e.g. passkey, hardware wallet).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum Signer {
    Delegated(Address),
    External(Address, Bytes),
}

/// Scope of a context rule — what kind of host function it governs.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum ContextRuleType {
    Default,
    CallContract(Address),
    CreateContract(BytesN<32>),
}

/// Full context rule as passed by the OZ smart account to policy entry-points.
/// Context rule IDs are monotonically incrementing u32 values unique within
/// one smart account; they are never reused after deletion.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ContextRule {
    pub id: u32,
    pub context_type: ContextRuleType,
    pub name: String,
    pub signers: Vec<Signer>,
    pub signer_ids: Vec<u32>,
    pub policies: Vec<Address>,
    pub policy_ids: Vec<u32>,
    /// Ledger sequence number after which this rule is invalid (None = no expiry).
    pub valid_until: Option<u32>,
}

// ── Policy error codes ──────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u32)]
pub enum PolicyError {
    NotInstalled           = 1,
    SpendingLimitExceeded  = 2,
    FrequencyLimitExceeded = 3,
    TimeWindowViolation    = 4,
    ScopeViolation         = 5,
    InvalidConfig          = 6,
    AlreadyInstalled       = 7,
    Unauthorized           = 8,
}

// ── Utility ─────────────────────────────────────────────────────────────────

/// Panic with a PolicyError via the soroban host.
#[inline(always)]
pub fn policy_panic(env: &Env, err: PolicyError) -> ! {
    env.panic_with_error(err)
}
