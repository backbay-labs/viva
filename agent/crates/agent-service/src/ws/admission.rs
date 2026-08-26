//! `SERVICE-012` / `SERVICE-017`: every server-owned capacity reservation, the
//! runtime handler/worker guards, provider queue accounting, and the drain that
//! closes admission.
//!
//! Moved verbatim out of `app.rs` by the responsibility split: no capacity
//! transition, lease lifetime, queue decision, or drain order changed.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use agent_domain::{BrainFailureStage, BrainProviderFailure, TerminalSessionReason};
use serde::Serialize;
use tokio::sync::{watch, Notify};

use crate::app::AppState;
use crate::config::VoiceLimitConfig;

// The websocket runtime's own namespace, so an item moved here resolves exactly
// as it did in the file it came from.
use super::*;

#[derive(Clone, Debug)]
pub struct VoiceLimitState {
    pub(super) active: Arc<Mutex<ActiveVoiceLimits>>,
    pub(super) provider_notify: Arc<Notify>,
}

impl Default for VoiceLimitState {
    fn default() -> Self {
        Self {
            active: Arc::new(Mutex::new(ActiveVoiceLimits::default())),
            provider_notify: Arc::new(Notify::new()),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub(super) struct ActiveVoiceLimits {
    pub(super) users: HashMap<String, usize>,
    pub(super) failure_control_identities: HashMap<String, usize>,
    pub(super) user_study_sets: HashMap<String, usize>,
    pub(super) ips: HashMap<String, usize>,
    pub(super) provider_inflight: usize,
    pub(super) provider_waiting: usize,
    pub(super) provider_backoff: Option<ProviderBackoffState>,
}

#[derive(Debug)]
pub struct VoiceLimitLease {
    pub(super) state: VoiceLimitState,
    pub(super) kind: VoiceLimitKind,
    pub(super) key: String,
}

#[derive(Debug)]
pub(super) struct ProviderQueueReservation {
    pub(super) state: VoiceLimitState,
    pub(super) released: bool,
}

impl ProviderQueueReservation {
    pub(super) fn new(state: VoiceLimitState) -> Self {
        Self {
            state,
            released: false,
        }
    }

    pub(super) fn disarm(mut self) {
        self.released = true;
    }
}

#[derive(Clone, Copy, Debug)]
pub(super) enum VoiceLimitKind {
    User,
    FailureControlIdentity,
    UserStudySet,
    Ip,
    Provider,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum ProviderQueueBehavior {
    Wait,
    Deny {
        reason: &'static str,
        terminal_reason: TerminalSessionReason,
    },
}

impl VoiceLimitState {
    pub fn try_acquire_user(&self, user_id: &str, max: usize) -> Option<VoiceLimitLease> {
        self.try_acquire(VoiceLimitKind::User, user_id, max)
    }

    pub fn try_acquire_failure_control_identity(
        &self,
        user_id: &str,
        max: usize,
    ) -> Option<VoiceLimitLease> {
        self.try_acquire(VoiceLimitKind::FailureControlIdentity, user_id, max)
    }

    pub fn try_acquire_user_study_set(
        &self,
        user_id: &str,
        study_set_id: &str,
        max: usize,
    ) -> Option<VoiceLimitLease> {
        let key = user_study_set_limit_key(user_id, study_set_id);
        self.try_acquire(VoiceLimitKind::UserStudySet, &key, max)
    }

    pub fn try_acquire_ip(&self, ip: &str, max: usize) -> Option<VoiceLimitLease> {
        self.try_acquire(VoiceLimitKind::Ip, ip, max)
    }

    /// `SERVICE-003`: server-owned proof of per-IP lease accounting. `None` means
    /// the key holds no lease at all — releasing the last lease removes the entry,
    /// so a client close frame is never what a test reads.
    pub fn ip_lease_count(&self, ip: &str) -> Option<usize> {
        self.active
            .lock()
            .expect("voice limit state lock poisoned")
            .ips
            .get(ip)
            .copied()
    }

    pub(crate) async fn try_admit_provider_turn(
        &self,
        limits: &VoiceLimitConfig,
        queue_behavior: ProviderQueueBehavior,
    ) -> ProviderAdmission {
        if !limits.provider_limiter_enabled {
            if let ProviderQueueBehavior::Deny {
                reason,
                terminal_reason,
            } = queue_behavior
            {
                return ProviderAdmission::denied(ProviderAdmissionDenial {
                    reason,
                    terminal_reason,
                    retry_after_ms: 0,
                    reset_hint: "none".to_owned(),
                    budget_state: "within_limit".to_owned(),
                    queue_depth: 0,
                    queue_delay_ms: 0,
                });
            }
            return ProviderAdmission::admitted(None, 0, "disabled");
        }
        let mut reservation: Option<ProviderQueueReservation> = None;
        let mut reserved_queue_depth = 0;
        let queue_started_at = Instant::now();
        loop {
            let notified = {
                let mut active = self.active.lock().expect("voice limit state lock poisoned");
                let now = Instant::now();
                if active
                    .provider_backoff
                    .as_ref()
                    .is_some_and(|backoff| backoff.until <= now)
                {
                    active.provider_backoff = None;
                }
                if let Some(backoff) = &active.provider_backoff {
                    let terminal_reason = backoff.terminal_reason;
                    let retry_after_ms = backoff.retry_after_ms;
                    let reset_hint = backoff.reset_hint.clone();
                    let budget_state = backoff.budget_state.clone();
                    let queue_depth = reservation
                        .as_ref()
                        .map_or(active.provider_inflight + active.provider_waiting, |_| {
                            reserved_queue_depth
                        });
                    let was_queued = reservation.is_some();
                    if let Some(reservation) = reservation.take() {
                        active.provider_waiting = active.provider_waiting.saturating_sub(1);
                        reservation.disarm();
                    }
                    return ProviderAdmission::denied(ProviderAdmissionDenial {
                        reason: "provider_backoff",
                        terminal_reason,
                        retry_after_ms,
                        reset_hint,
                        budget_state,
                        queue_depth,
                        queue_delay_ms: if was_queued {
                            elapsed_ms(queue_started_at)
                        } else {
                            0
                        },
                    });
                }
                if let ProviderQueueBehavior::Deny {
                    reason,
                    terminal_reason,
                } = queue_behavior
                {
                    return ProviderAdmission::denied(ProviderAdmissionDenial {
                        reason,
                        terminal_reason,
                        retry_after_ms: 0,
                        reset_hint: "none".to_owned(),
                        budget_state: "within_limit".to_owned(),
                        queue_depth: active.provider_inflight + active.provider_waiting,
                        queue_delay_ms: 0,
                    });
                }
                if let Some(max) = limits.max_provider_concurrent_turns {
                    let queued_ahead = reservation.is_none() && active.provider_waiting > 0;
                    if active.provider_inflight >= max || queued_ahead {
                        let max_queue_depth = limits.max_provider_queue_depth.unwrap_or(0);
                        if reservation.is_none() {
                            let queue_depth = active.provider_inflight + active.provider_waiting;
                            let deny_busy = match queue_behavior {
                                ProviderQueueBehavior::Wait => None,
                                ProviderQueueBehavior::Deny {
                                    reason,
                                    terminal_reason,
                                } => Some((reason, terminal_reason)),
                            };
                            if max == 0
                                || active.provider_waiting >= max_queue_depth
                                || deny_busy.is_some()
                            {
                                let (reason, terminal_reason, retry_after_ms) =
                                    if let Some((reason, terminal_reason)) = deny_busy {
                                        (reason, terminal_reason, 0)
                                    } else {
                                        (
                                            if max_queue_depth == 0 {
                                                "provider_queue_full"
                                            } else {
                                                "provider_queue_saturated"
                                            },
                                            TerminalSessionReason::ProviderRateLimited,
                                            limits.provider_backoff_default_ms,
                                        )
                                    };
                                return ProviderAdmission::denied(ProviderAdmissionDenial {
                                    reason,
                                    terminal_reason,
                                    retry_after_ms,
                                    reset_hint: "none".to_owned(),
                                    budget_state: "within_limit".to_owned(),
                                    queue_depth,
                                    queue_delay_ms: 0,
                                });
                            }
                            active.provider_waiting = active.provider_waiting.saturating_add(1);
                            reserved_queue_depth = queue_depth;
                            reservation = Some(ProviderQueueReservation::new(self.clone()));
                        }
                        self.provider_notify.clone().notified_owned()
                    } else {
                        let was_queued = reservation.is_some();
                        if let Some(reservation) = reservation.take() {
                            active.provider_waiting = active.provider_waiting.saturating_sub(1);
                            reservation.disarm();
                        }
                        let queue_depth = if reserved_queue_depth > 0 {
                            reserved_queue_depth
                        } else {
                            active.provider_inflight
                        };
                        active.provider_inflight = active.provider_inflight.saturating_add(1);
                        return ProviderAdmission::admitted_with_delay(
                            Some(VoiceLimitLease {
                                state: self.clone(),
                                kind: VoiceLimitKind::Provider,
                                key: "global".to_owned(),
                            }),
                            queue_depth,
                            if was_queued {
                                elapsed_ms(queue_started_at)
                            } else {
                                0
                            },
                            "within_limit",
                        );
                    }
                } else {
                    let was_queued = reservation.is_some();
                    if let Some(reservation) = reservation.take() {
                        active.provider_waiting = active.provider_waiting.saturating_sub(1);
                        reservation.disarm();
                    }
                    let queue_depth = if reserved_queue_depth > 0 {
                        reserved_queue_depth
                    } else {
                        active.provider_inflight
                    };
                    active.provider_inflight = active.provider_inflight.saturating_add(1);
                    return ProviderAdmission::admitted_with_delay(
                        Some(VoiceLimitLease {
                            state: self.clone(),
                            kind: VoiceLimitKind::Provider,
                            key: "global".to_owned(),
                        }),
                        queue_depth,
                        if was_queued {
                            elapsed_ms(queue_started_at)
                        } else {
                            0
                        },
                        "within_limit",
                    );
                }
            };
            notified.await;
        }
    }

    pub(crate) fn provider_backoff_admission(
        &self,
        limits: &VoiceLimitConfig,
    ) -> Option<ProviderAdmission> {
        if !limits.provider_limiter_enabled {
            return None;
        }
        let mut active = self.active.lock().expect("voice limit state lock poisoned");
        let now = Instant::now();
        if active
            .provider_backoff
            .as_ref()
            .is_some_and(|backoff| backoff.until <= now)
        {
            active.provider_backoff = None;
        }
        active.provider_backoff.as_ref().map(|backoff| {
            ProviderAdmission::denied(ProviderAdmissionDenial {
                reason: "provider_backoff",
                terminal_reason: backoff.terminal_reason,
                retry_after_ms: backoff.retry_after_ms,
                reset_hint: backoff.reset_hint.clone(),
                budget_state: backoff.budget_state.clone(),
                queue_depth: active.provider_inflight + active.provider_waiting,
                queue_delay_ms: 0,
            })
        })
    }

    pub(crate) fn record_provider_failure(
        &self,
        limits: &VoiceLimitConfig,
        failure: &BrainProviderFailure,
    ) {
        if !limits.provider_limiter_enabled || !provider_failure_backoff_eligible(failure) {
            return;
        }
        let retry_after_ms = metadata_u64(failure.metadata(), "retry_after_ms")
            .unwrap_or(limits.provider_backoff_default_ms)
            .min(limits.provider_backoff_max_ms);
        let reset_hint =
            metadata_value(failure.metadata(), "reset_hint").unwrap_or_else(|| "none".to_owned());
        let budget_state = metadata_value(failure.metadata(), "budget_state")
            .unwrap_or_else(|| "unknown".to_owned());
        self.record_provider_backoff(ProviderBackoffState {
            until: Instant::now() + Duration::from_millis(retry_after_ms),
            retry_after_ms,
            reset_hint,
            budget_state,
            terminal_reason: failure.terminal_reason(),
        });
    }

    pub(super) fn record_provider_backoff(&self, backoff: ProviderBackoffState) {
        let now = Instant::now();
        {
            let mut active = self.active.lock().expect("voice limit state lock poisoned");
            let keep_existing = active
                .provider_backoff
                .as_ref()
                .is_some_and(|existing| existing.until > now && existing.until >= backoff.until);
            if !keep_existing {
                active.provider_backoff = Some(backoff);
            }
        }
        self.provider_notify.notify_waiters();
    }

    pub(super) fn try_acquire(
        &self,
        kind: VoiceLimitKind,
        key: &str,
        max: usize,
    ) -> Option<VoiceLimitLease> {
        let mut active = self.active.lock().expect("voice limit state lock poisoned");
        let counts = match kind {
            VoiceLimitKind::User => &mut active.users,
            VoiceLimitKind::FailureControlIdentity => &mut active.failure_control_identities,
            VoiceLimitKind::UserStudySet => &mut active.user_study_sets,
            VoiceLimitKind::Ip => &mut active.ips,
            VoiceLimitKind::Provider => unreachable!("provider admission uses provider counter"),
        };
        let count = counts.entry(key.to_owned()).or_default();
        if *count >= max {
            return None;
        }
        *count += 1;
        Some(VoiceLimitLease {
            state: self.clone(),
            kind,
            key: key.to_owned(),
        })
    }

    pub(super) fn release(&self, kind: VoiceLimitKind, key: &str) {
        let mut active = self.active.lock().expect("voice limit state lock poisoned");
        let counts = match kind {
            VoiceLimitKind::User => &mut active.users,
            VoiceLimitKind::FailureControlIdentity => &mut active.failure_control_identities,
            VoiceLimitKind::UserStudySet => &mut active.user_study_sets,
            VoiceLimitKind::Ip => &mut active.ips,
            VoiceLimitKind::Provider => {
                active.provider_inflight = active.provider_inflight.saturating_sub(1);
                drop(active);
                self.provider_notify.notify_one();
                return;
            }
        };
        if let Some(count) = counts.get_mut(key) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                counts.remove(key);
            }
        }
    }

    /// `SERVICE-012`: counts only. The map keys this reads over — user ids and
    /// client addresses — never leave the lock.
    pub(crate) fn lease_counts(&self) -> VoiceLeaseCounts {
        let active = self.active.lock().expect("voice limit state lock poisoned");
        VoiceLeaseCounts {
            users: active.users.values().copied().sum(),
            ips: active.ips.values().copied().sum(),
            provider_inflight: active.provider_inflight,
            provider_waiting: active.provider_waiting,
        }
    }

    pub(super) fn release_provider_queue_waiter(&self) {
        let should_notify = {
            let mut active = self.active.lock().expect("voice limit state lock poisoned");
            active.provider_waiting = active.provider_waiting.saturating_sub(1);
            active.provider_waiting > 0
        };
        if should_notify {
            self.provider_notify.notify_one();
        }
    }
}

pub(super) fn user_study_set_limit_key(user_id: &str, study_set_id: &str) -> String {
    format!("{user_id}\0{study_set_id}")
}

impl Drop for VoiceLimitLease {
    fn drop(&mut self) {
        self.state.release(self.kind, &self.key);
    }
}

impl Drop for ProviderQueueReservation {
    fn drop(&mut self) {
        if !self.released {
            self.state.release_provider_queue_waiter();
        }
    }
}

#[derive(Clone, Debug)]
pub(super) struct ProviderBackoffState {
    pub(super) until: Instant,
    pub(super) retry_after_ms: u64,
    pub(super) reset_hint: String,
    pub(super) budget_state: String,
    pub(super) terminal_reason: TerminalSessionReason,
}

#[derive(Debug)]
pub(crate) struct ProviderAdmission {
    pub(crate) decision: ProviderAdmissionDecision,
    pub(crate) lease: Option<VoiceLimitLease>,
    pub(crate) queue_depth: usize,
    pub(crate) queue_delay_ms: u64,
    pub(crate) budget_state: String,
}

impl ProviderAdmission {
    pub(super) fn admitted(
        lease: Option<VoiceLimitLease>,
        queue_depth: usize,
        budget_state: &str,
    ) -> Self {
        Self::admitted_with_delay(lease, queue_depth, 0, budget_state)
    }

    pub(super) fn admitted_with_delay(
        lease: Option<VoiceLimitLease>,
        queue_depth: usize,
        queue_delay_ms: u64,
        budget_state: &str,
    ) -> Self {
        Self {
            decision: ProviderAdmissionDecision::Admitted,
            lease,
            queue_depth,
            queue_delay_ms,
            budget_state: budget_state.to_owned(),
        }
    }

    pub(crate) fn denied(denial: ProviderAdmissionDenial) -> Self {
        Self {
            queue_depth: denial.queue_depth,
            queue_delay_ms: denial.queue_delay_ms,
            budget_state: denial.budget_state.clone(),
            decision: ProviderAdmissionDecision::Denied(denial),
            lease: None,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) enum ProviderAdmissionDecision {
    Admitted,
    Denied(ProviderAdmissionDenial),
}

#[derive(Clone, Debug)]
pub(crate) struct ProviderAdmissionDenial {
    pub(crate) reason: &'static str,
    pub(crate) terminal_reason: TerminalSessionReason,
    pub(crate) retry_after_ms: u64,
    pub(crate) reset_hint: String,
    pub(crate) budget_state: String,
    pub(crate) queue_depth: usize,
    pub(crate) queue_delay_ms: u64,
}

pub(super) fn metadata_value(metadata: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}=");
    metadata.split_whitespace().find_map(|part| {
        part.strip_prefix(&prefix)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    })
}

pub(super) fn metadata_u64(metadata: &str, key: &str) -> Option<u64> {
    metadata_value(metadata, key).and_then(|value| value.parse().ok())
}

pub(super) fn elapsed_ms(start: Instant) -> u64 {
    start.elapsed().as_millis().try_into().unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use agent_domain::BrainFailureClass;

    use super::*;

    fn provider_rate_limit_failure(retry_after_ms: u64, reset_hint: &str) -> BrainProviderFailure {
        BrainProviderFailure::new(agent_domain::BrainProviderFailureParts {
            failure_class: BrainFailureClass::QuotaRateFailure,
            stage: BrainFailureStage::Gemini,
            retry_eligible: true,
            latency_ms: 17,
            provider: "gemini".to_owned(),
            model: "gemini-3.5-flash".to_owned(),
            metadata: format!(
                "retry_after_ms={retry_after_ms} reset_hint={reset_hint} budget_state=within_limit"
            ),
        })
    }

    #[tokio::test]
    async fn server_tool_stage_timeout_does_not_record_provider_backoff() {
        for stage in [BrainFailureStage::Tools, BrainFailureStage::Recap] {
            let state = VoiceLimitState::default();
            let limits = VoiceLimitConfig {
                provider_backoff_default_ms: 1_000,
                provider_backoff_max_ms: 30_000,
                ..VoiceLimitConfig::default()
            };
            let failure = BrainProviderFailure::new(agent_domain::BrainProviderFailureParts {
                failure_class: BrainFailureClass::Timeout,
                stage,
                retry_eligible: true,
                latency_ms: 45_000,
                provider: "server".to_owned(),
                model: "viva-tools".to_owned(),
                metadata: "retry_after_ms=30000 reset_hint=none budget_state=unknown".to_owned(),
            });

            state.record_provider_failure(&limits, &failure);

            let admission = state
                .try_admit_provider_turn(&limits, ProviderQueueBehavior::Wait)
                .await;
            assert!(
                matches!(admission.decision, ProviderAdmissionDecision::Admitted),
                "server-owned {stage} timeout must not poison provider backoff"
            );
        }
    }

    #[tokio::test]
    async fn provider_backoff_preserves_longer_active_window() {
        let state = VoiceLimitState::default();
        let limits = VoiceLimitConfig {
            provider_backoff_default_ms: 1_000,
            provider_backoff_max_ms: 30_000,
            ..VoiceLimitConfig::default()
        };

        state.record_provider_failure(
            &limits,
            &provider_rate_limit_failure(30_000, "2030-01-01T00:00:00Z"),
        );
        state.record_provider_failure(
            &limits,
            &provider_rate_limit_failure(1_000, "2030-01-01T00:00:01Z"),
        );

        let admission = state
            .try_admit_provider_turn(&limits, ProviderQueueBehavior::Wait)
            .await;
        let ProviderAdmissionDecision::Denied(denial) = admission.decision else {
            panic!("active provider backoff should deny admission");
        };
        assert_eq!(denial.reason, "provider_backoff");
        assert_eq!(denial.retry_after_ms, 30_000);
        assert_eq!(denial.reset_hint, "2030-01-01T00:00:00Z");
        assert_eq!(denial.budget_state, "within_limit");
    }

    #[tokio::test]
    async fn provider_zero_concurrency_denies_without_waiting() {
        let state = VoiceLimitState::default();
        let limits = VoiceLimitConfig {
            max_provider_concurrent_turns: Some(0),
            max_provider_queue_depth: Some(1),
            provider_backoff_default_ms: 1_000,
            ..VoiceLimitConfig::default()
        };

        let admission = tokio::time::timeout(
            Duration::from_millis(50),
            state.try_admit_provider_turn(&limits, ProviderQueueBehavior::Wait),
        )
        .await
        .expect("zero provider concurrency must deny instead of waiting forever");
        let ProviderAdmissionDecision::Denied(denial) = admission.decision else {
            panic!("zero provider concurrency should deny admission");
        };
        assert_eq!(denial.reason, "provider_queue_saturated");
        assert_eq!(denial.queue_depth, 0);
        assert_eq!(denial.retry_after_ms, 1_000);
    }

    #[tokio::test]
    async fn provider_queue_waiter_state_blocks_fresh_caller() {
        let state = VoiceLimitState::default();
        let limits = VoiceLimitConfig {
            max_provider_concurrent_turns: Some(1),
            max_provider_queue_depth: Some(1),
            ..VoiceLimitConfig::default()
        };
        {
            let mut active = state
                .active
                .lock()
                .expect("voice limit state lock poisoned");
            active.provider_waiting = 1;
        }

        let fresh = state
            .try_admit_provider_turn(&limits, ProviderQueueBehavior::Wait)
            .await;
        let ProviderAdmissionDecision::Denied(denial) = fresh.decision else {
            panic!("fresh admission should not steal a queued waiter's provider slot");
        };
        assert_eq!(denial.reason, "provider_queue_saturated");
        assert_eq!(denial.queue_depth, 1);
    }

    #[tokio::test]
    async fn provider_deny_behavior_rejects_before_spare_global_capacity() {
        let state = VoiceLimitState::default();
        let limits = VoiceLimitConfig::default();
        let first = state
            .try_admit_provider_turn(&limits, ProviderQueueBehavior::Wait)
            .await;
        assert!(matches!(
            first.decision,
            ProviderAdmissionDecision::Admitted
        ));

        let second = state
            .try_admit_provider_turn(
                &limits,
                ProviderQueueBehavior::Deny {
                    reason: "overlapping_provider_turn",
                    terminal_reason: TerminalSessionReason::SlowClient,
                },
            )
            .await;

        let ProviderAdmissionDecision::Denied(denial) = second.decision else {
            panic!("same-socket deny behavior must reject even when global capacity is spare");
        };
        assert_eq!(denial.reason, "overlapping_provider_turn");
        assert_eq!(denial.terminal_reason, TerminalSessionReason::SlowClient);
        assert_eq!(denial.queue_depth, 1);
        assert_eq!(denial.retry_after_ms, 0);
    }

    #[tokio::test]
    async fn provider_cancelled_notified_waiter_wakes_next_waiter() {
        let state = VoiceLimitState::default();
        {
            let mut active = state
                .active
                .lock()
                .expect("voice limit state lock poisoned");
            active.provider_waiting = 2;
        }
        let notified = state.provider_notify.clone().notified_owned();
        let cancelled = ProviderQueueReservation::new(state.clone());

        drop(cancelled);

        tokio::time::timeout(Duration::from_millis(50), notified)
            .await
            .expect("cancelled queued waiter should notify the next waiter when capacity is open");
        assert_eq!(
            state
                .active
                .lock()
                .expect("voice limit state lock poisoned")
                .provider_waiting,
            1
        );
    }

    #[tokio::test]
    async fn provider_cancelled_notified_waiter_wakes_next_waiter_with_nonzero_inflight() {
        let state = VoiceLimitState::default();
        {
            let mut active = state
                .active
                .lock()
                .expect("voice limit state lock poisoned");
            active.provider_inflight = 1;
            active.provider_waiting = 2;
        }
        let notified = state.provider_notify.clone().notified_owned();
        let cancelled = ProviderQueueReservation::new(state.clone());

        drop(cancelled);

        tokio::time::timeout(Duration::from_millis(50), notified)
            .await
            .expect(
                "cancelled queued waiter should notify the next waiter even with nonzero inflight",
            );
        let active = state
            .active
            .lock()
            .expect("voice limit state lock poisoned");
        assert_eq!(active.provider_inflight, 1);
        assert_eq!(active.provider_waiting, 1);
    }
}

pub(super) fn provider_failure_backoff_eligible(failure: &BrainProviderFailure) -> bool {
    matches!(
        failure.terminal_reason(),
        TerminalSessionReason::ProviderRateLimited
            | TerminalSessionReason::ProviderAuthFailed
            | TerminalSessionReason::ProviderTimeout
    ) && failure.provider() != "server"
        && !matches!(
            failure.stage(),
            BrainFailureStage::Tools | BrainFailureStage::Recap | BrainFailureStage::Store
        )
}

#[derive(Clone, Debug)]
pub struct VoiceDrainSignal {
    pub(super) sender: Arc<watch::Sender<bool>>,
}

impl Default for VoiceDrainSignal {
    fn default() -> Self {
        let (sender, _receiver) = watch::channel(false);
        Self {
            sender: Arc::new(sender),
        }
    }
}

impl VoiceDrainSignal {
    pub fn begin_drain(&self) {
        self.sender.send_replace(true);
    }

    pub fn subscribe(&self) -> watch::Receiver<bool> {
        self.sender.subscribe()
    }

    pub fn is_draining(&self) -> bool {
        *self.sender.borrow()
    }
}

/// `SERVICE-012`: the counts a lease-accounting read can expose. The keys the
/// limiter maps are indexed by stay behind the lock.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct VoiceLeaseCounts {
    pub(crate) users: usize,
    pub(crate) ips: usize,
    pub(crate) provider_inflight: usize,
    pub(crate) provider_waiting: usize,
}

/// `SERVICE-012`: live runtime occupancy, as counts and one drain flag. This is
/// the only runtime detail an operator-authenticated probe is given: there is no
/// field here that could carry a user id, a client address, or a session id.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct VoiceRuntimeSnapshot {
    pub session_capacity: usize,
    pub session_in_use: usize,
    pub user_leases: usize,
    pub ip_leases: usize,
    pub provider_inflight: usize,
    pub provider_waiting: usize,
    pub active_handlers: usize,
    pub background_workers: usize,
    pub draining: bool,
}

/// The runtime refused an entry because the process has started draining.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("voice runtime is draining")]
pub struct RuntimeDraining;

/// `SERVICE-012`: the server's own count of in-flight socket handlers and
/// background workers, and the gate that closes admission the moment a drain
/// starts. `enter` checks the drain flag and increments under one lock, so a
/// handler cannot be admitted after `begin_drain` has returned.
#[derive(Clone, Debug, Default)]
pub struct VoiceRuntimeTracker {
    pub(super) state: Arc<Mutex<VoiceRuntimeState>>,
    pub(super) zero: Arc<Notify>,
}

#[derive(Debug, Default)]
pub(super) struct VoiceRuntimeState {
    pub(super) draining: bool,
    pub(super) active_handlers: usize,
    pub(super) background_workers: usize,
}

/// Held for exactly as long as one socket handler runs. Dropping it is what the
/// drain waits on, so it is carried into the handler by `VoiceAdmission` rather
/// than released at the end of the upgrade.
pub struct ActiveHandlerGuard {
    pub(super) tracker: VoiceRuntimeTracker,
}

/// Held for exactly as long as one server-owned background worker runs.
///
/// `D-04 CONFIRM_DELETE` is the selected deletion branch, so this service starts
/// no deletion-finalizer worker and no production path acquires this guard; the
/// `background_workers` count is therefore provably zero on every drain. The
/// guard exists because the drain contract waits on both counters, and a drain
/// that could only see handlers would silently succeed past a worker.
pub struct BackgroundWorkerGuard {
    pub(super) tracker: VoiceRuntimeTracker,
}

impl VoiceRuntimeTracker {
    pub fn enter(&self) -> Result<ActiveHandlerGuard, RuntimeDraining> {
        let mut state = self.state.lock().expect("runtime tracker lock poisoned");
        if state.draining {
            return Err(RuntimeDraining);
        }
        state.active_handlers = state
            .active_handlers
            .checked_add(1)
            .expect("active handler counter overflow");
        Ok(ActiveHandlerGuard {
            tracker: self.clone(),
        })
    }

    pub fn begin_drain(&self) {
        self.state
            .lock()
            .expect("runtime tracker lock poisoned")
            .draining = true;
    }

    pub fn enter_background_worker(&self) -> Result<BackgroundWorkerGuard, RuntimeDraining> {
        let mut state = self.state.lock().expect("runtime tracker lock poisoned");
        if state.draining {
            return Err(RuntimeDraining);
        }
        state.background_workers = state
            .background_workers
            .checked_add(1)
            .expect("background worker counter overflow");
        Ok(BackgroundWorkerGuard {
            tracker: self.clone(),
        })
    }

    /// `(active_handlers, background_workers)` — the two counters the drain waits
    /// on, read together under one lock so they cannot disagree.
    pub fn counts(&self) -> (usize, usize) {
        let state = self.state.lock().expect("runtime tracker lock poisoned");
        (state.active_handlers, state.background_workers)
    }

    pub fn is_draining(&self) -> bool {
        self.state
            .lock()
            .expect("runtime tracker lock poisoned")
            .draining
    }
}

impl Drop for ActiveHandlerGuard {
    fn drop(&mut self) {
        let reached_zero = {
            let mut state = self
                .tracker
                .state
                .lock()
                .expect("runtime tracker lock poisoned");
            state.active_handlers = state
                .active_handlers
                .checked_sub(1)
                .expect("active handler guard dropped twice");
            state.active_handlers == 0 && state.background_workers == 0
        };
        if reached_zero {
            self.tracker.zero.notify_waiters();
        }
    }
}

impl Drop for BackgroundWorkerGuard {
    fn drop(&mut self) {
        let reached_zero = {
            let mut state = self
                .tracker
                .state
                .lock()
                .expect("runtime tracker lock poisoned");
            state.background_workers = state
                .background_workers
                .checked_sub(1)
                .expect("background worker guard dropped twice");
            state.active_handlers == 0 && state.background_workers == 0
        };
        if reached_zero {
            self.tracker.zero.notify_waiters();
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DrainOutcome {
    Drained,
    TimedOut(VoiceRuntimeSnapshot),
}

/// `SERVICE-012`: close admission, wind every accepted session down, and wait for
/// the server's own counters — not a client close frame — to reach zero.
///
/// The tracker's drain flag is set first so no handler can be admitted behind the
/// wait, then the watch signal tells the sessions already accepted to stop. The
/// grace is an absolute deadline: it is measured from the moment the drain
/// started, so a session that finishes late cannot extend it.
pub async fn begin_drain_and_wait(state: &AppState, grace: Duration) -> DrainOutcome {
    state.runtime_tracker.begin_drain();
    state.drain_signal.begin_drain();

    let deadline = tokio::time::Instant::now() + grace;
    loop {
        // The waiter is registered — `enable`, not merely constructed — before the
        // zero check, so the last guard drop cannot land in the gap between them.
        let notified = state.runtime_tracker.zero.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if state.runtime_tracker.counts() == (0, 0) {
            return DrainOutcome::Drained;
        }
        if tokio::time::timeout_at(deadline, notified).await.is_err() {
            return DrainOutcome::TimedOut(state.runtime_snapshot());
        }
    }
}

/// `SERVICE-012`: the server's own admission/drain accounting. Every assertion in
/// this module reads a server-owned counter, guard, or snapshot — a client frame
/// and a locally green mock prove nothing here.
#[cfg(test)]
mod runtime_tracker_tests {
    use super::*;
    use crate::config::VoiceWsAccess;

    fn tracker_test_state(max_sessions: usize) -> AppState {
        let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
        AppState::with_study_store(
            Arc::new(agent_adapters::SyntheticBrain::with_study_store(
                store.clone(),
            )),
            "synthetic",
            VoiceWsAccess::default(),
            max_sessions,
            store,
        )
    }

    #[test]
    fn runtime_tracker_guard_moves_exactly_one_counter() {
        let tracker = VoiceRuntimeTracker::default();
        assert_eq!(tracker.counts(), (0, 0));

        let first = tracker.enter().expect("a fresh tracker admits a handler");
        let second = tracker.enter().expect("a second handler is admitted");
        assert_eq!(tracker.counts(), (2, 0));

        let worker = tracker
            .enter_background_worker()
            .expect("a background worker is admitted");
        assert_eq!(tracker.counts(), (2, 1));

        drop(second);
        assert_eq!(tracker.counts(), (1, 1));
        drop(worker);
        assert_eq!(tracker.counts(), (1, 0));
        drop(first);
        assert_eq!(tracker.counts(), (0, 0));
    }

    #[test]
    fn runtime_tracker_refuses_entry_once_draining() {
        let tracker = VoiceRuntimeTracker::default();
        let held = tracker.enter().expect("the pre-drain handler is admitted");

        tracker.begin_drain();

        assert_eq!(tracker.enter().map(|_| ()), Err(RuntimeDraining));
        assert_eq!(
            tracker.enter_background_worker().map(|_| ()),
            Err(RuntimeDraining)
        );
        assert!(tracker.is_draining());
        assert_eq!(
            tracker.counts(),
            (1, 0),
            "a refused entry must not move a counter"
        );

        drop(held);
        assert_eq!(tracker.counts(), (0, 0));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn runtime_tracker_concurrent_guard_drops_reach_zero_exactly_once() {
        let tracker = VoiceRuntimeTracker::default();
        let guards = (0..64)
            .map(|_| tracker.enter().expect("every handler is admitted"))
            .collect::<Vec<_>>();
        let workers = (0..16)
            .map(|_| {
                tracker
                    .enter_background_worker()
                    .expect("every worker is admitted")
            })
            .collect::<Vec<_>>();
        assert_eq!(tracker.counts(), (64, 16));

        let mut handles = Vec::new();
        for guard in guards {
            handles.push(tokio::spawn(async move {
                drop(guard);
            }));
        }
        for worker in workers {
            handles.push(tokio::spawn(async move {
                drop(worker);
            }));
        }
        for handle in handles {
            handle.await.expect("guard drop task");
        }

        assert_eq!(tracker.counts(), (0, 0));
    }

    #[tokio::test(start_paused = true)]
    async fn runtime_tracker_waiter_started_before_the_last_drop_observes_zero() {
        let state = tracker_test_state(2);
        let guard = state
            .runtime_tracker
            .enter()
            .expect("the handler is admitted before the drain");
        let waiter = {
            let state = state.clone();
            tokio::spawn(async move { begin_drain_and_wait(&state, Duration::from_secs(20)).await })
        };

        // Paused time only advances when every task is idle, so this resolves
        // exactly when the drain future is parked on its zero notification —
        // the drop below therefore genuinely happens after the wait started.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(state.runtime_tracker.is_draining());
        assert_eq!(state.runtime_tracker.counts(), (1, 0));

        drop(guard);

        assert_eq!(waiter.await.expect("drain task"), DrainOutcome::Drained);
        assert_eq!(state.runtime_tracker.counts(), (0, 0));
        assert!(state.runtime_snapshot().draining);
    }

    /// The registration ordering itself, not merely the happy path: the waiter is
    /// enabled before every zero check, so a last guard drop landing on another
    /// thread in exactly that window still wakes the drain. `notify_waiters`
    /// stores no permit, so a drop that arrives before the waiter registers is
    /// lost forever — the drain would then sit out its whole grace with the
    /// runtime already at zero.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn runtime_tracker_registers_its_waiter_before_each_zero_check() {
        for attempt in 0..500 {
            let state = tracker_test_state(1);
            let guard = state
                .runtime_tracker
                .enter()
                .expect("the handler is admitted before the drain");
            let tracker = state.runtime_tracker.clone();
            // A real thread, released the instant the drain latches, so the drop
            // lands on the check/registration boundary rather than politely after
            // the waiter has parked.
            let dropper = std::thread::spawn(move || {
                while !tracker.is_draining() {
                    std::hint::spin_loop();
                }
                drop(guard);
            });

            let outcome = begin_drain_and_wait(&state, Duration::from_millis(50)).await;
            dropper.join().expect("dropper thread");

            assert_eq!(
                outcome,
                DrainOutcome::Drained,
                "attempt {attempt}: a concurrent last drop was missed"
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn runtime_tracker_waiter_started_after_zero_returns_without_waiting() {
        let state = tracker_test_state(2);
        drop(state.runtime_tracker.enter().expect("admitted"));
        let started = tokio::time::Instant::now();

        let outcome = begin_drain_and_wait(&state, Duration::from_secs(20)).await;

        assert_eq!(outcome, DrainOutcome::Drained);
        assert_eq!(started.elapsed(), Duration::ZERO);
        assert!(state.drain_signal.is_draining());
    }

    #[tokio::test(start_paused = true)]
    async fn runtime_tracker_grace_timeout_reports_the_remaining_handler() {
        let state = tracker_test_state(3);
        let _permit = state
            .session_slots
            .clone()
            .try_acquire_owned()
            .expect("a session slot is available");
        let _guard = state.runtime_tracker.enter().expect("admitted");
        let started = tokio::time::Instant::now();

        let outcome = begin_drain_and_wait(&state, Duration::from_secs(20)).await;

        assert_eq!(started.elapsed(), Duration::from_secs(20));
        let DrainOutcome::TimedOut(snapshot) = outcome else {
            panic!("a held handler must time the grace out, got {outcome:?}");
        };
        assert_eq!(
            snapshot,
            VoiceRuntimeSnapshot {
                session_capacity: 3,
                session_in_use: 1,
                user_leases: 0,
                ip_leases: 0,
                provider_inflight: 0,
                provider_waiting: 0,
                active_handlers: 1,
                background_workers: 0,
                draining: true,
            }
        );
    }

    #[tokio::test(start_paused = true)]
    async fn runtime_tracker_grace_timeout_reports_a_remaining_background_worker() {
        let state = tracker_test_state(1);
        let _worker = state
            .runtime_tracker
            .enter_background_worker()
            .expect("admitted");

        let outcome = begin_drain_and_wait(&state, Duration::from_secs(20)).await;

        let DrainOutcome::TimedOut(snapshot) = outcome else {
            panic!("a held background worker must time the grace out, got {outcome:?}");
        };
        assert_eq!(snapshot.active_handlers, 0);
        assert_eq!(snapshot.background_workers, 1);
        assert!(snapshot.draining);
    }

    #[test]
    fn runtime_tracker_snapshot_serializes_counts_only() {
        let state = tracker_test_state(4);
        let user_lease = state
            .limit_state
            .try_acquire_user("user-with-a-recognisable-identity", 4)
            .expect("user lease");
        let ip_lease = state
            .limit_state
            .try_acquire_ip("203.0.113.9", 4)
            .expect("ip lease");

        let rendered = serde_json::to_value(state.runtime_snapshot()).expect("snapshot serializes");
        let object = rendered.as_object().expect("snapshot is a JSON object");
        let mut keys = object.keys().map(String::as_str).collect::<Vec<_>>();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "active_handlers",
                "background_workers",
                "draining",
                "ip_leases",
                "provider_inflight",
                "provider_waiting",
                "session_capacity",
                "session_in_use",
                "user_leases",
            ]
        );
        let text = rendered.to_string();
        assert!(!text.contains("user-with-a-recognisable-identity"));
        assert!(!text.contains("203.0.113.9"));
        assert_eq!(object["user_leases"], 1);
        assert_eq!(object["ip_leases"], 1);

        drop(user_lease);
        drop(ip_lease);
        assert_eq!(state.runtime_snapshot().user_leases, 0);
        assert_eq!(state.runtime_snapshot().ip_leases, 0);
    }
}

pub(super) const RECONNECT_LEASE_GRACE: Duration = Duration::from_millis(250);

pub(super) const RECONNECT_LEASE_RETRY_INTERVAL: Duration = Duration::from_millis(10);

pub(super) const MAX_ACTIVE_SESSIONS_PER_USER_STUDY_SET: usize = 1;

/// The three per-session capacity reservations a socket must hold for its whole
/// life, moved out of the session loop as one unit.
///
/// `SERVICE-017`: the field order is load-bearing and is the reverse of the
/// order the three leases were acquired in. The locals this replaces dropped in
/// reverse declaration order at every early return; struct fields drop in
/// declaration order, so declaring them backwards keeps the release order the
/// session loop always had. The end-of-session release drops each field by name
/// so that order is stated, not inferred.
pub(super) struct SessionLeases {
    pub(super) user_study_set: VoiceLimitLease,
    pub(super) user_total: Option<VoiceLimitLease>,
    pub(super) failure_control_identity: Option<VoiceLimitLease>,
}

/// `SERVICE-017`: acquire the failure-control identity, per-user, and
/// user/study-set reservations in that exact order.
///
/// `None` means capacity was denied: this has already emitted the session-cap
/// terminal phase, closed the socket, and recorded the terminal reason, so the
/// caller returns. Every reservation already taken is released after that
/// record, exactly as it was when these three locals unwound at the caller's
/// own `return`.
pub(super) async fn acquire_session_leases<S>(
    state: &AppState,
    sender: &mut BoundedSender<S>,
    session_binding: &AuthorizedClientSession,
    failure_control: Option<FailureControlScenario>,
) -> Option<SessionLeases>
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    let failure_control_identity = match (
        failure_control,
        state.failure_control.max_sessions_per_identity(),
    ) {
        (Some(_), Some(max)) => match acquire_failure_control_identity_lease_with_reconnect_grace(
            &state.limit_state,
            &session_binding.user_id,
            max,
            RECONNECT_LEASE_GRACE,
        )
        .await
        {
            Some(lease) => Some(lease),
            None => return close_denied_session_capacity(state, sender).await,
        },
        _ => None,
    };
    let user_total = match state.voice_limits.max_user_sessions {
        Some(max) => match acquire_user_lease_with_reconnect_grace(
            &state.limit_state,
            &session_binding.user_id,
            max,
            RECONNECT_LEASE_GRACE,
        )
        .await
        {
            Some(lease) => Some(lease),
            None => return close_denied_session_capacity(state, sender).await,
        },
        None => None,
    };
    let user_study_set = match acquire_user_study_set_with_reconnect_grace(
        &state.limit_state,
        &session_binding.user_id,
        &session_binding.study_set_id,
        MAX_ACTIVE_SESSIONS_PER_USER_STUDY_SET,
        RECONNECT_LEASE_GRACE,
    )
    .await
    {
        Some(lease) => lease,
        None => return close_denied_session_capacity(state, sender).await,
    };
    Some(SessionLeases {
        user_study_set,
        user_total,
        failure_control_identity,
    })
}

async fn close_denied_session_capacity<S>(
    state: &AppState,
    sender: &mut BoundedSender<S>,
) -> Option<SessionLeases>
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    let terminal_reason = close_with_terminal_session_phase_only(
        sender,
        TerminalSessionReason::SessionCap,
        close_code::POLICY,
    )
    .await;
    record_terminal(state, None, terminal_reason).await;
    None
}

/// `SERVICE-017`: the provider backoff gate a new socket passes before any
/// provider input, moved out of the session loop.
///
/// `false` means the socket was denied, already closed, and already recorded.
/// The admission — and any lease it carried — is released on return, which is
/// where the caller's `if let` block released it before.
pub(super) async fn admit_provider_backoff<S>(
    state: &AppState,
    sender: &mut BoundedSender<S>,
    voice_session_id: Option<String>,
) -> bool
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    let Some(admission) = state
        .limit_state
        .provider_backoff_admission(&state.voice_limits)
    else {
        return true;
    };
    record_provider_admission(state, voice_session_id.clone(), &admission);
    let ProviderAdmissionDecision::Denied(denial) = admission.decision else {
        return true;
    };
    let terminal_reason =
        close_with_terminal_session_phase_only(sender, denial.terminal_reason, close_code::POLICY)
            .await;
    record_terminal(state, voice_session_id, terminal_reason).await;
    false
}

pub(super) async fn acquire_user_lease_with_reconnect_grace(
    limits: &VoiceLimitState,
    user_id: &str,
    max: usize,
    grace: Duration,
) -> Option<VoiceLimitLease> {
    acquire_with_reconnect_grace(|| limits.try_acquire_user(user_id, max), grace).await
}

pub(super) async fn acquire_failure_control_identity_lease_with_reconnect_grace(
    limits: &VoiceLimitState,
    user_id: &str,
    max: usize,
    grace: Duration,
) -> Option<VoiceLimitLease> {
    acquire_with_reconnect_grace(
        || limits.try_acquire_failure_control_identity(user_id, max),
        grace,
    )
    .await
}

pub(super) async fn acquire_user_study_set_with_reconnect_grace(
    limits: &VoiceLimitState,
    user_id: &str,
    study_set_id: &str,
    max: usize,
    grace: Duration,
) -> Option<VoiceLimitLease> {
    acquire_with_reconnect_grace(
        || limits.try_acquire_user_study_set(user_id, study_set_id, max),
        grace,
    )
    .await
}

pub(super) async fn acquire_with_reconnect_grace(
    mut acquire: impl FnMut() -> Option<VoiceLimitLease>,
    grace: Duration,
) -> Option<VoiceLimitLease> {
    if let Some(lease) = acquire() {
        return Some(lease);
    }

    let started_at = Instant::now();
    while started_at.elapsed() < grace {
        tokio::time::sleep(RECONNECT_LEASE_RETRY_INTERVAL).await;
        if let Some(lease) = acquire() {
            return Some(lease);
        }
    }
    None
}

pub(super) struct VoiceAdmission {
    pub(super) _permit: OwnedSemaphorePermit,
    /// `None` only when per-IP limiting is disabled for this deployment.
    pub(super) _ip_lease: Option<VoiceLimitLease>,
    /// `SERVICE-012`: carried into the socket handler so the process drain waits
    /// on the handler itself, not on the upgrade that started it.
    pub(super) _handler_guard: ActiveHandlerGuard,
    pub(super) principal: UpgradePrincipal,
}

pub(super) struct SessionLimitRuntime {
    pub(super) audio_window_started_at: Instant,
    pub(super) audio_bytes_this_window: u64,
    pub(super) session_cost_usd: f64,
}

impl SessionLimitRuntime {
    pub(super) fn new() -> Self {
        Self {
            audio_window_started_at: Instant::now(),
            audio_bytes_this_window: 0,
            session_cost_usd: 0.0,
        }
    }

    pub(super) fn record_audio_bytes(&mut self, limits: &VoiceLimitConfig, bytes: u64) -> bool {
        let Some(max_bytes) = limits.max_audio_bytes_per_minute else {
            return true;
        };
        if self.audio_window_started_at.elapsed() >= Duration::from_secs(60) {
            self.audio_window_started_at = Instant::now();
            self.audio_bytes_this_window = 0;
        }
        if self.audio_bytes_this_window.saturating_add(bytes) > max_bytes {
            return false;
        }
        self.audio_bytes_this_window = self.audio_bytes_this_window.saturating_add(bytes);
        true
    }

    pub(super) fn record_session_cost(&mut self, limits: &VoiceLimitConfig, cost_usd: f64) -> bool {
        if cost_usd.is_finite() && cost_usd > 0.0 {
            self.session_cost_usd += cost_usd;
        }
        match limits.max_session_cost_usd {
            Some(max_cost_usd) => self.session_cost_usd <= max_cost_usd,
            None => true,
        }
    }

    pub(super) fn cost_budget_exhausted(&self, limits: &VoiceLimitConfig) -> bool {
        limits
            .max_session_cost_usd
            .is_some_and(|max_cost_usd| self.session_cost_usd >= max_cost_usd)
    }
}

pub(super) fn client_input_requires_provider_admission(client_input: &ClientInputAction) -> bool {
    client_input.action().arms_turn_cap()
}

#[derive(Debug)]
pub(super) struct QueuedProviderAdmission {
    pub(super) client_input: ClientInputAction,
    pub(super) admission: ProviderAdmission,
}

pub(super) fn start_provider_admission(
    limit_state: VoiceLimitState,
    limits: VoiceLimitConfig,
    client_input: ClientInputAction,
    queue_behavior: ProviderQueueBehavior,
) -> Fuse<BoxFuture<'static, QueuedProviderAdmission>> {
    async move {
        let admission = limit_state
            .try_admit_provider_turn(&limits, queue_behavior)
            .await;
        QueuedProviderAdmission {
            client_input,
            admission,
        }
    }
    .boxed()
    .fuse()
}

pub(super) fn record_provider_admission(
    state: &AppState,
    voice_session_id: Option<String>,
    admission: &ProviderAdmission,
) {
    let detail = match &admission.decision {
        ProviderAdmissionDecision::Admitted => format!(
            "admission_decision=admitted queue_depth={} queue_delay_ms={} retry_after_ms=0 reset_hint=none terminal_reason=none budget_state={}",
            admission.queue_depth, admission.queue_delay_ms, admission.budget_state
        ),
        ProviderAdmissionDecision::Denied(denial) => format!(
            "admission_decision=denied reason={} terminal_reason={} queue_depth={} queue_delay_ms={} retry_after_ms={} reset_hint={} budget_state={}",
            denial.reason,
            denial.terminal_reason.as_str(),
            denial.queue_depth,
            denial.queue_delay_ms,
            denial.retry_after_ms,
            denial.reset_hint,
            denial.budget_state
        ),
    };
    state.evidence.record(VoiceEvidenceEvent::new(
        VoiceEvidenceEventKind::ProviderAdmission,
        voice_session_id,
        detail,
    ));
}
