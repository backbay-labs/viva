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

/// Plan 06 Task 5 (`DOMAIN-007`): text-as-PCM is absent from the production API.
/// `AudioFrame` is built from decoded PCM16 bytes or from validated base64 and
/// from nothing else, so no adapter, service, or fixture can reinterpret a string
/// as audio samples.
#[test]
fn audio_frames_cannot_be_built_from_text() {
    trybuild::TestCases::new().compile_fail("tests/ui/audio_frame_text_constructor.rs");
}

/// Plan 06 Task 3A Step 2A (`DOMAIN-011`): the recorded D-04 selector is
/// `CONFIRM_DELETE`, so the domain compiles no soft-delete/restore surface at all.
/// These two cases are registered only on the selected branch; under
/// `SOFT_DELETE_UNDO` they would be replaced by `tests/deletion_contract.rs`.
#[test]
fn confirm_delete_publishes_no_restore_types() {
    trybuild::TestCases::new().compile_fail("tests/ui/d04_restore_types_absent.rs");
}

#[test]
fn confirm_delete_publishes_no_restore_or_finalizer_ports() {
    trybuild::TestCases::new().compile_fail("tests/ui/d04_restore_methods_absent.rs");
}
