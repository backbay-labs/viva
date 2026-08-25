//! Plan 06 Task 1 (`DOMAIN-003`, `DOMAIN-005`): the study session phase machine.
//!
//! Every ordered phase pair is enumerated, not a happy-path sample: the table
//! test walks all 36 combinations so a newly permitted illegal edge cannot hide
//! between examples. The terminal state is proven absorbing for every phase and
//! for a second `terminate`, and `restart_after_cancellation` is proven to be an
//! explicit, narrow method rather than a general backward transition.
//!
//! The terminal-string assertions pin Plan 04's single `study.rs` declaration
//! (`define_terminal_session_reasons!`): the serde token, `as_str`, `Display`,
//! and the close text must all come from that one authority, and the close text
//! is derived here from the wire token rather than restated. Plan 04 ships
//! `close_reason() -> &'static str` with a compile-time close/wire assertion,
//! which supersedes the plan's illustrative `-> String`; the derivation the
//! parity assertion checks is unchanged.

use std::collections::BTreeSet;

use agent_domain::{
    StudySessionPhase, StudySessionState, StudySessionTransitionError, TerminalSessionReason,
};

const PHASES: [StudySessionPhase; 6] = [
    StudySessionPhase::Ready,
    StudySessionPhase::Listening,
    StudySessionPhase::Thinking,
    StudySessionPhase::Feedback,
    StudySessionPhase::Correction,
    StudySessionPhase::Recap,
];

const LEGAL: [(StudySessionPhase, StudySessionPhase); 6] = [
    (StudySessionPhase::Ready, StudySessionPhase::Listening),
    (StudySessionPhase::Listening, StudySessionPhase::Thinking),
    (StudySessionPhase::Thinking, StudySessionPhase::Feedback),
    (StudySessionPhase::Feedback, StudySessionPhase::Correction),
    (StudySessionPhase::Correction, StudySessionPhase::Listening),
    (StudySessionPhase::Correction, StudySessionPhase::Recap),
];

/// The active phases a cancelled turn may restart from. `Ready` has no turn to
/// cancel and `Recap` is past the point of restarting one.
const RESTARTABLE: [StudySessionPhase; 4] = [
    StudySessionPhase::Listening,
    StudySessionPhase::Thinking,
    StudySessionPhase::Feedback,
    StudySessionPhase::Correction,
];

/// The one legal walk from `Ready` through every phase, used so no test can
/// observe a state the machine itself would refuse to produce.
const WALK: [StudySessionPhase; 5] = [
    StudySessionPhase::Listening,
    StudySessionPhase::Thinking,
    StudySessionPhase::Feedback,
    StudySessionPhase::Correction,
    StudySessionPhase::Recap,
];

fn legal_walk(phase: StudySessionPhase) -> &'static [StudySessionPhase] {
    match phase {
        StudySessionPhase::Ready => &WALK[..0],
        StudySessionPhase::Listening => &WALK[..1],
        StudySessionPhase::Thinking => &WALK[..2],
        StudySessionPhase::Feedback => &WALK[..3],
        StudySessionPhase::Correction => &WALK[..4],
        StudySessionPhase::Recap => &WALK[..5],
    }
}

fn state_at(phase: StudySessionPhase) -> StudySessionState {
    let mut state = StudySessionState::ready();
    for step in legal_walk(phase) {
        assert_eq!(
            state.transition(*step),
            Ok(*step),
            "the legal walk to {phase:?} must be accepted",
        );
    }
    assert_eq!(state.phase(), phase);
    assert!(!state.is_terminal());
    assert_eq!(state.terminal_reason(), None);
    state
}

#[test]
fn transition_table_is_exhaustive() {
    for from in PHASES {
        for to in PHASES {
            assert_eq!(
                from.can_transition_to(to),
                LEGAL.contains(&(from, to)),
                "unexpected transition {from:?} -> {to:?}",
            );
        }
    }
}

#[test]
fn state_transitions_apply_exactly_the_legal_table() {
    for from in PHASES {
        for to in PHASES {
            let mut state = state_at(from);
            let outcome = state.transition(to);

            if LEGAL.contains(&(from, to)) {
                assert_eq!(outcome, Ok(to), "legal {from:?} -> {to:?} must be applied");
                assert_eq!(state.phase(), to);
                assert!(!state.is_terminal());
                assert_eq!(state.terminal_reason(), None);
            } else {
                assert_eq!(
                    outcome,
                    Err(StudySessionTransitionError::Illegal { from, to }),
                    "illegal {from:?} -> {to:?} must be a typed rejection",
                );
                assert_eq!(
                    state.phase(),
                    from,
                    "a rejected transition must not move the phase",
                );
                assert!(!state.is_terminal());
            }
        }
    }
}

#[test]
fn ready_state_starts_non_terminal_at_ready() {
    let state = StudySessionState::ready();

    assert_eq!(state.phase(), StudySessionPhase::Ready);
    assert_eq!(state.terminal_reason(), None);
    assert!(!state.is_terminal());
}

#[test]
fn terminal_state_is_absorbing() {
    let mut state = StudySessionState::ready();
    state
        .terminate(TerminalSessionReason::ProviderTimeout)
        .unwrap();

    assert_eq!(state.phase(), StudySessionPhase::Recap);
    assert!(state.is_terminal());
    assert_eq!(
        state.terminal_reason(),
        Some(TerminalSessionReason::ProviderTimeout),
    );

    for next in PHASES {
        assert!(matches!(
            state.transition(next),
            Err(StudySessionTransitionError::AlreadyTerminal {
                reason: TerminalSessionReason::ProviderTimeout,
            })
        ));
    }
    assert!(matches!(
        state.terminate(TerminalSessionReason::Rollback),
        Err(StudySessionTransitionError::AlreadyTerminal {
            reason: TerminalSessionReason::ProviderTimeout,
        })
    ));
    assert!(matches!(
        state.restart_after_cancellation(),
        Err(StudySessionTransitionError::AlreadyTerminal {
            reason: TerminalSessionReason::ProviderTimeout,
        })
    ));

    assert_eq!(state.phase(), StudySessionPhase::Recap);
    assert_eq!(
        state.terminal_reason(),
        Some(TerminalSessionReason::ProviderTimeout),
        "the first terminal reason is the only terminal reason",
    );
}

#[test]
fn every_non_terminal_phase_can_terminate_once_with_its_reason() {
    for phase in PHASES {
        for reason in TerminalSessionReason::ALL {
            let mut state = state_at(phase);

            assert_eq!(
                state.terminate(reason),
                Ok(StudySessionPhase::Recap),
                "{phase:?} must be able to terminate with {reason:?}",
            );
            assert!(state.is_terminal());
            assert_eq!(state.phase(), StudySessionPhase::Recap);
            assert_eq!(state.terminal_reason(), Some(reason));
            assert!(matches!(
                state.terminate(reason),
                Err(StudySessionTransitionError::AlreadyTerminal { .. })
            ));
        }
    }
}

#[test]
fn restart_after_cancellation_returns_active_turns_to_listening() {
    for phase in RESTARTABLE {
        let mut state = state_at(phase);

        assert_eq!(
            state.restart_after_cancellation(),
            Ok(StudySessionPhase::Listening),
            "a cancelled turn in {phase:?} must restart at Listening",
        );
        assert_eq!(state.phase(), StudySessionPhase::Listening);
        assert!(!state.is_terminal());
        assert_eq!(state.terminal_reason(), None);
    }
}

#[test]
fn restart_after_cancellation_rejects_ready_and_recap() {
    for phase in [StudySessionPhase::Ready, StudySessionPhase::Recap] {
        let mut state = state_at(phase);

        assert_eq!(
            state.restart_after_cancellation(),
            Err(StudySessionTransitionError::Illegal {
                from: phase,
                to: StudySessionPhase::Listening,
            }),
            "{phase:?} has no cancelled turn to restart",
        );
        assert_eq!(
            state.phase(),
            phase,
            "a rejected restart must not move the phase"
        );
    }
}

#[test]
fn restart_after_cancellation_rejects_every_terminal_session() {
    for reason in TerminalSessionReason::ALL {
        let mut state = state_at(StudySessionPhase::Correction);
        state.terminate(reason).unwrap();

        assert_eq!(
            state.restart_after_cancellation(),
            Err(StudySessionTransitionError::AlreadyTerminal { reason }),
            "a session terminated with {reason:?} must never restart",
        );
        assert_eq!(state.phase(), StudySessionPhase::Recap);
        assert_eq!(state.terminal_reason(), Some(reason));
    }
}

#[test]
fn terminal_tokens_serialize_from_one_authority() {
    let mut tokens = BTreeSet::new();

    for reason in TerminalSessionReason::ALL {
        assert_eq!(
            serde_json::to_value(reason).unwrap(),
            serde_json::Value::String(reason.as_str().to_owned()),
            "the serde token for {reason:?} must be its as_str authority",
        );
        assert_eq!(
            serde_json::from_value::<TerminalSessionReason>(serde_json::Value::String(
                reason.as_str().to_owned()
            ))
            .unwrap(),
            reason,
            "the wire token for {reason:?} must round-trip to the same variant",
        );
        assert_eq!(reason.close_reason(), reason.as_str().replace('_', " "));
        assert_eq!(
            reason.to_string(),
            reason.as_str(),
            "Display must write as_str and keep no second match",
        );

        let token = reason.as_str();
        assert!(!token.is_empty(), "{reason:?} must have a wire token");
        assert!(
            token
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'_'),
            "terminal token {token:?} must stay lowercase snake_case wire vocabulary",
        );
        assert!(tokens.insert(token), "duplicate terminal token {token:?}");
    }

    assert_eq!(
        tokens.len(),
        16,
        "TerminalSessionReason::ALL must expose all 16 distinct terminal tokens",
    );
    assert_eq!(TerminalSessionReason::ALL.len(), 16);

    assert!(
        serde_json::from_value::<TerminalSessionReason>(serde_json::Value::String(
            "provider_timeout_v2".to_owned()
        ))
        .is_err(),
        "the terminal vocabulary is closed: no alias, catch-all, or second spelling",
    );
}
