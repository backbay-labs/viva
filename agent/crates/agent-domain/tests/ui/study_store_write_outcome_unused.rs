// Plan 06 Task 3 (`DOMAIN-006`): `StudyStoreWriteOutcome` must carry `#[must_use]`
// on the enum itself, not merely inherit `Result`'s must-use behavior. Once the
// outcome has been unwrapped out of its `Result`, dropping it on the floor still
// has to be a diagnostic — otherwise a caller can "handle" a write by ignoring
// whether it inserted or replayed.

#![deny(unused_must_use)]

use agent_domain::StudyStoreWriteOutcome;

fn discard_write_outcome(outcome: StudyStoreWriteOutcome) {
    outcome;
}

fn main() {
    discard_write_outcome(StudyStoreWriteOutcome::Inserted);
}
