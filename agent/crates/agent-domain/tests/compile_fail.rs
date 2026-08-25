//! Plan 06 Task 2 (`DOMAIN-004`): compile-proofs that the sanitizing constructor
//! is the only way to build a `BrainProviderFailure`.
//!
//! A runtime test cannot prove that a field is unreachable; only the compiler
//! can. The UI case below populates every field with a struct literal and must
//! fail on private fields — if the fields ever become public again the case
//! compiles and this test goes red.

#[test]
fn failure_fields_cannot_be_bypassed_with_a_struct_literal() {
    trybuild::TestCases::new().compile_fail("tests/ui/brain_provider_failure_struct_literal.rs");
}
