//! The study session phase machine (`DOMAIN-003`).
//!
//! `agent-domain` owns one legal-transition table and one absorbing terminal
//! state so no adapter or service may carry a second copy. Plan 04 owns the
//! `StudySessionPhase` and `TerminalSessionReason` declarations in `study.rs`;
//! this module adds behaviour to them and redeclares neither the phase variants
//! nor a terminal-reason string.
//!
//! Every mutator returns the resulting phase or a typed
//! [`StudySessionTransitionError`], so an illegal or post-terminal emission is a
//! rejected value rather than a silently applied phase.

use crate::study::{StudySessionPhase, TerminalSessionReason};

impl StudySessionPhase {
    /// The complete legal phase table. All 36 ordered pairs are decided here;
    /// the six listed pairs are legal and every other pair is illegal.
    ///
    /// Backward motion is deliberately absent: a cancelled turn returns to
    /// `Listening` only through
    /// [`StudySessionState::restart_after_cancellation`], which is narrower
    /// than a general backward transition.
    #[must_use]
    pub const fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Ready, Self::Listening)
                | (Self::Listening, Self::Thinking)
                | (Self::Thinking, Self::Feedback)
                | (Self::Feedback, Self::Correction)
                | (Self::Correction, Self::Listening)
                | (Self::Correction, Self::Recap)
        )
    }
}

/// A single session's phase plus, once terminated, the reason it ended.
///
/// A terminal session is absorbing: no transition, restart, or second
/// `terminate` may change its phase or overwrite its first terminal reason.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StudySessionState {
    phase: StudySessionPhase,
    terminal_reason: Option<TerminalSessionReason>,
}

/// Why a phase mutation was refused.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum StudySessionTransitionError {
    #[error("illegal study session phase transition: {from:?} -> {to:?}")]
    Illegal {
        from: StudySessionPhase,
        to: StudySessionPhase,
    },
    #[error("study session is already terminal: {reason}")]
    AlreadyTerminal { reason: TerminalSessionReason },
}

impl StudySessionState {
    /// A fresh, non-terminal session at [`StudySessionPhase::Ready`].
    #[must_use]
    pub const fn ready() -> Self {
        Self {
            phase: StudySessionPhase::Ready,
            terminal_reason: None,
        }
    }

    #[must_use]
    pub const fn phase(self) -> StudySessionPhase {
        self.phase
    }

    #[must_use]
    pub const fn terminal_reason(self) -> Option<TerminalSessionReason> {
        self.terminal_reason
    }

    #[must_use]
    pub const fn is_terminal(self) -> bool {
        self.terminal_reason.is_some()
    }

    /// Applies one of the six legal pairs, or rejects the emission.
    ///
    /// # Errors
    ///
    /// Returns [`StudySessionTransitionError::AlreadyTerminal`] once the
    /// session has terminated, and [`StudySessionTransitionError::Illegal`] for
    /// any pair outside [`StudySessionPhase::can_transition_to`].
    pub fn transition(
        &mut self,
        to: StudySessionPhase,
    ) -> Result<StudySessionPhase, StudySessionTransitionError> {
        self.reject_if_terminal()?;
        if !self.phase.can_transition_to(to) {
            return Err(StudySessionTransitionError::Illegal {
                from: self.phase,
                to,
            });
        }
        self.phase = to;
        Ok(self.phase)
    }

    /// Returns an in-flight turn to [`StudySessionPhase::Listening`] after the
    /// learner cancels it.
    ///
    /// This is the only backward motion in the machine and it is explicit:
    /// `Ready` has no turn to cancel, `Recap` is past restarting one, and a
    /// terminated session never restarts.
    ///
    /// # Errors
    ///
    /// Returns [`StudySessionTransitionError::AlreadyTerminal`] for a
    /// terminated session and [`StudySessionTransitionError::Illegal`] from
    /// `Ready` or `Recap`.
    pub fn restart_after_cancellation(
        &mut self,
    ) -> Result<StudySessionPhase, StudySessionTransitionError> {
        self.reject_if_terminal()?;
        match self.phase {
            StudySessionPhase::Listening
            | StudySessionPhase::Thinking
            | StudySessionPhase::Feedback
            | StudySessionPhase::Correction => {
                self.phase = StudySessionPhase::Listening;
                Ok(self.phase)
            }
            from @ (StudySessionPhase::Ready | StudySessionPhase::Recap) => {
                Err(StudySessionTransitionError::Illegal {
                    from,
                    to: StudySessionPhase::Listening,
                })
            }
        }
    }

    /// Ends the session at [`StudySessionPhase::Recap`] with `reason`.
    ///
    /// # Errors
    ///
    /// Returns [`StudySessionTransitionError::AlreadyTerminal`] carrying the
    /// first reason if the session has already terminated; the original reason
    /// is never overwritten.
    pub fn terminate(
        &mut self,
        reason: TerminalSessionReason,
    ) -> Result<StudySessionPhase, StudySessionTransitionError> {
        self.reject_if_terminal()?;
        self.phase = StudySessionPhase::Recap;
        self.terminal_reason = Some(reason);
        Ok(self.phase)
    }

    fn reject_if_terminal(self) -> Result<(), StudySessionTransitionError> {
        match self.terminal_reason {
            Some(reason) => Err(StudySessionTransitionError::AlreadyTerminal { reason }),
            None => Ok(()),
        }
    }
}
