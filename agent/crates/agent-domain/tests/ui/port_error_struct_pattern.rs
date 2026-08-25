// Plan 06 Task 3 (`DOMAIN-006`, part of `DOMAIN-009`): `PortError::reason` is a
// diagnostic, never classification authority. A consumer must not be able to
// destructure it out and match on the prose. Every name used here is exported by
// `agent_domain`, so the only thing this file can fail on is the private field.

use agent_domain::PortError;

fn main() {
    let error = PortError::durability(
        "study_store",
        "voice-session-1",
        "connection pool timed out while committing the answer attempt",
    );

    let PortError { reason, .. } = error;

    println!("{reason}");
}
