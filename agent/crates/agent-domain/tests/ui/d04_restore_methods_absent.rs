// Plan 06 Task 3A Step 2A (`DOMAIN-011`), recorded selector D-04 = `CONFIRM_DELETE`.
//
// Under `CONFIRM_DELETE` the `StudyMemoryStore` port publishes neither a restore
// method nor a deletion finalizer, so no adapter can quietly grow one and no
// service can call one. Both names are probed on `&dyn StudyMemoryStore` and must
// fail to compile with no-method diagnostics.
//
// `StudyMemoryStore` itself is exported by `agent_domain`, so the only thing this
// file can fail on is the two absent methods.

use agent_domain::StudyMemoryStore;

async fn probe_restore_surface(store: &dyn StudyMemoryStore) {
    store.restore_study_set().await;
    store.finalize_expired_study_set_deletions(100).await;
}

fn main() {}
