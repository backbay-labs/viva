// Plan 06 Task 3A Step 2A (`DOMAIN-011`), recorded selector D-04 = `CONFIRM_DELETE`.
//
// Under `CONFIRM_DELETE` the domain publishes no soft-delete/restore value types.
// Absence is not something a runtime test can observe, so it is pinned here: this
// file imports the four `SOFT_DELETE_UNDO` type names and must fail to compile
// with unresolved-import diagnostics naming all four.
//
// `main` is deliberately empty. Referencing the names in a body would only add
// cascading "cannot find type" errors; if any of the four types were ever
// declared and exported, the import would resolve, this file would compile (with
// an unused-import warning), and trybuild would report the absence proof as
// broken — which is exactly the signal this case exists to raise.

use agent_domain::{
    RestoreStudySetInputV1, RestoreStudySetOutcomeKindV1, RestoreStudySetOutcomeV1,
    SoftDeleteReceiptV1,
};

fn main() {}
