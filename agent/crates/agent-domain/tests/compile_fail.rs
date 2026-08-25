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

/// Plan 06 Task 3 (`DOMAIN-006`, part of `DOMAIN-009`): `PortError` classifies by
/// `PortErrorKind`. Its `reason` is diagnostic prose, so a consumer must not be
/// able to destructure it out of the error and classify on the text.
#[test]
fn port_error_reason_cannot_be_destructured_for_classification() {
    trybuild::TestCases::new().compile_fail("tests/ui/port_error_struct_pattern.rs");
}

/// Plan 06 Task 3 (`DOMAIN-006`): the `#[must_use]` lives on
/// `StudyStoreWriteOutcome` itself, so an unwrapped write outcome still cannot be
/// dropped silently. `Result`'s independent must-use behavior would not catch
/// this.
#[test]
fn study_store_write_outcome_cannot_be_dropped_silently() {
    trybuild::TestCases::new().compile_fail("tests/ui/study_store_write_outcome_unused.rs");
}
