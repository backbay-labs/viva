use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, RwLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use agent_domain::{
    BrainFailureStage, BrainProviderFailure, BrainUsage, CreateFileStudySet, CreatePasteStudySet,
    LibrarySessionSummary, LibraryStudyDocumentSummary, LibraryStudySetSummary, PortError,
    PortErrorKind, RealtimeBrain, StudyMemoryStore, StudySetIngestionRecord,
    StudySetIngestionStatus, TerminalSessionReason, VoiceUsageRecord,
};
use axum::{
    extract::{Path, Query},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    routing::{delete, get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use observe::{usage_event, CostModel, VoiceEvidenceEvent, VoiceUsageEvent};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::{watch, Notify, Semaphore};
use uuid::Uuid;

use crate::{
    config::{
        bac_510_max_turn_duration, FailureControlClaim, FailureControlClaimRequest,
        FailureControlConfig, OperatorAccess, RecorderLimits, RedactedSecret, SessionTokenClaims,
        TrustedProxyConfig, VoiceLimitConfig, VoiceWsAccess,
    },
    ws::voice_ws,
};

#[derive(Clone)]
pub struct AppState {
    pub brain: Arc<dyn RealtimeBrain>,
    pub study_store: Arc<dyn StudyMemoryStore>,
    pub provider: String,
    pub trusted_user_id: String,
    pub trusted_study_set_id: String,
    pub trusted_session_id: String,
    pub trusted_session_sequence: Arc<AtomicU64>,
    pub ws_access: VoiceWsAccess,
    pub operator_access: OperatorAccess,
    pub trusted_proxies: TrustedProxyConfig,
    pub session_slots: Arc<Semaphore>,
    pub ws_timeouts: WsTimeouts,
    pub turn_cap_override: bool,
    pub voice_limits: VoiceLimitConfig,
    pub limit_state: VoiceLimitState,
    pub drain_signal: VoiceDrainSignal,
    pub evidence: VoiceEvidenceRecorder,
    pub usage: VoiceUsageRecorder,
    pub unauthenticated_paste_allowed: bool,
    pub failure_control: FailureControlConfig,
}

impl AppState {
    pub fn new(
        brain: Arc<dyn RealtimeBrain>,
        provider: impl Into<String>,
        ws_access: VoiceWsAccess,
        max_sessions: usize,
    ) -> Self {
        Self::with_study_store(
            brain,
            provider,
            ws_access,
            max_sessions,
            Arc::new(data::InMemoryStudyStore::seeded_fixture()),
        )
    }

    pub fn with_study_store(
        brain: Arc<dyn RealtimeBrain>,
        provider: impl Into<String>,
        ws_access: VoiceWsAccess,
        max_sessions: usize,
        study_store: Arc<dyn StudyMemoryStore>,
    ) -> Self {
        Self {
            brain,
            study_store,
            provider: provider.into(),
            trusted_user_id: "user-1".to_owned(),
            trusted_study_set_id: "biology-midterm".to_owned(),
            trusted_session_id: "voice-session-1".to_owned(),
            trusted_session_sequence: Arc::new(AtomicU64::new(0)),
            ws_access,
            operator_access: OperatorAccess::default(),
            trusted_proxies: TrustedProxyConfig::default(),
            session_slots: Arc::new(Semaphore::new(max_sessions)),
            ws_timeouts: WsTimeouts::default(),
            turn_cap_override: false,
            voice_limits: VoiceLimitConfig::default(),
            limit_state: VoiceLimitState::default(),
            drain_signal: VoiceDrainSignal::default(),
            evidence: VoiceEvidenceRecorder::default(),
            usage: VoiceUsageRecorder::default(),
            unauthenticated_paste_allowed: true,
            failure_control: FailureControlConfig::default(),
        }
    }

    pub fn with_trusted_user_id(mut self, trusted_user_id: impl Into<String>) -> Self {
        self.trusted_user_id = trusted_user_id.into();
        self
    }

    pub fn with_trusted_study_set_id(mut self, trusted_study_set_id: impl Into<String>) -> Self {
        self.trusted_study_set_id = trusted_study_set_id.into();
        self
    }

    pub fn with_trusted_session_id(mut self, trusted_session_id: impl Into<String>) -> Self {
        self.trusted_session_id = trusted_session_id.into();
        self
    }

    pub fn next_trusted_voice_session_id(&self) -> String {
        let sequence = self
            .trusted_session_sequence
            .fetch_add(1, Ordering::Relaxed)
            + 1;
        Uuid::from_u128(u128::from(sequence)).to_string()
    }

    pub fn with_ws_timeouts(mut self, ws_timeouts: WsTimeouts) -> Self {
        self.turn_cap_override = ws_timeouts.idle != WsTimeouts::default().idle;
        self.ws_timeouts = ws_timeouts;
        self
    }

    pub fn with_operator_access(mut self, operator_access: OperatorAccess) -> Self {
        self.operator_access = operator_access;
        self
    }

    pub fn with_trusted_proxies(mut self, trusted_proxies: TrustedProxyConfig) -> Self {
        self.trusted_proxies = trusted_proxies;
        self
    }

    /// Rebuilds both voice recorders against the configured retention bound. It
    /// runs at startup, before any event exists, so no retained event is lost.
    pub fn with_recorder_limits(mut self, recorder_limits: RecorderLimits) -> Self {
        self.evidence = VoiceEvidenceRecorder::with_capacity(recorder_limits.evidence_events);
        self.usage = VoiceUsageRecorder::with_capacity(recorder_limits.usage_events);
        self
    }

    pub fn with_turn_cap_override(mut self, turn_cap_override: bool) -> Self {
        self.turn_cap_override = turn_cap_override;
        self
    }

    pub fn with_voice_limits(mut self, voice_limits: VoiceLimitConfig) -> Self {
        self.voice_limits = voice_limits;
        self
    }

    pub fn with_unauthenticated_paste_allowed(mut self, allowed: bool) -> Self {
        self.unauthenticated_paste_allowed = allowed;
        self
    }

    pub fn with_failure_control(mut self, failure_control: FailureControlConfig) -> Self {
        self.failure_control = failure_control;
        self
    }

    pub fn is_ready(&self) -> bool {
        let brain = self.brain.capabilities();
        let store = self.study_store.capabilities();
        brain.configured && brain.selectable && store.available && !self.drain_signal.is_draining()
    }
}

#[derive(Clone, Debug)]
pub struct VoiceLimitState {
    active: Arc<Mutex<ActiveVoiceLimits>>,
    provider_notify: Arc<Notify>,
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
struct ActiveVoiceLimits {
    users: HashMap<String, usize>,
    failure_control_identities: HashMap<String, usize>,
    user_study_sets: HashMap<String, usize>,
    ips: HashMap<String, usize>,
    provider_inflight: usize,
    provider_waiting: usize,
    provider_backoff: Option<ProviderBackoffState>,
}

#[derive(Debug)]
pub struct VoiceLimitLease {
    state: VoiceLimitState,
    kind: VoiceLimitKind,
    key: String,
}

#[derive(Debug)]
struct ProviderQueueReservation {
    state: VoiceLimitState,
    released: bool,
}

impl ProviderQueueReservation {
    fn new(state: VoiceLimitState) -> Self {
        Self {
            state,
            released: false,
        }
    }

    fn disarm(mut self) {
        self.released = true;
    }
}

#[derive(Clone, Copy, Debug)]
enum VoiceLimitKind {
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

    fn record_provider_backoff(&self, backoff: ProviderBackoffState) {
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

    fn try_acquire(&self, kind: VoiceLimitKind, key: &str, max: usize) -> Option<VoiceLimitLease> {
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

    fn release(&self, kind: VoiceLimitKind, key: &str) {
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

    fn release_provider_queue_waiter(&self) {
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

fn user_study_set_limit_key(user_id: &str, study_set_id: &str) -> String {
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
struct ProviderBackoffState {
    until: Instant,
    retry_after_ms: u64,
    reset_hint: String,
    budget_state: String,
    terminal_reason: TerminalSessionReason,
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
    fn admitted(lease: Option<VoiceLimitLease>, queue_depth: usize, budget_state: &str) -> Self {
        Self::admitted_with_delay(lease, queue_depth, 0, budget_state)
    }

    fn admitted_with_delay(
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

fn metadata_value(metadata: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}=");
    metadata.split_whitespace().find_map(|part| {
        part.strip_prefix(&prefix)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    })
}

fn metadata_u64(metadata: &str, key: &str) -> Option<u64> {
    metadata_value(metadata, key).and_then(|value| value.parse().ok())
}

fn elapsed_ms(start: Instant) -> u64 {
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

fn provider_failure_backoff_eligible(failure: &BrainProviderFailure) -> bool {
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

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/", get(root))
        .route("/health", get(health))
        .route("/live", get(live))
        .route("/ready", get(ready))
        .route("/health/brain", get(brain_health))
        .route(
            "/study-sets/paste",
            post(create_paste_study_set).options(paste_options),
        )
        .route(
            "/study-sets/files",
            post(create_file_study_set).options(paste_options),
        )
        .route(
            "/study-sets/{study_set_id}/files/retry",
            post(retry_file_study_set).options(paste_options),
        )
        .route(
            "/study-sets/export",
            get(library_export).options(paste_options),
        )
        .route("/study-sets/library", get(library_snapshot))
        .route(
            "/study-sets/{study_set_id}",
            delete(delete_study_set).options(paste_options),
        )
        .route(
            "/study-sets/{study_set_id}/sessions/{voice_session_id}",
            delete(delete_session_history).options(paste_options),
        )
        .route("/ws", get(voice_ws))
        .with_state(state)
}

/// Every long-lived WebSocket bound, resolved once from server configuration. A
/// client frame can never extend one of these.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WsTimeouts {
    pub first_frame: Duration,
    pub idle: Duration,
    pub between_turn_idle: Duration,
    pub session: Duration,
    pub heartbeat_interval: Duration,
    pub pong_timeout: Duration,
    pub outbound_write: Duration,
    pub drain_grace: Duration,
}

impl Default for WsTimeouts {
    fn default() -> Self {
        Self {
            first_frame: Duration::from_secs(10),
            idle: bac_510_max_turn_duration(),
            between_turn_idle: Duration::from_secs(600),
            session: Duration::from_secs(6 * 60 * 60),
            heartbeat_interval: Duration::from_secs(30),
            pong_timeout: Duration::from_secs(10),
            outbound_write: Duration::from_secs(5),
            drain_grace: Duration::from_secs(20),
        }
    }
}

#[derive(Clone, Debug)]
pub struct VoiceDrainSignal {
    sender: Arc<watch::Sender<bool>>,
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

/// `SERVICE-005`: what a caller may read about retention without walking the
/// retained events.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct RecorderStats {
    pub capacity: usize,
    pub retained: usize,
    pub total_recorded: u64,
    pub dropped: u64,
}

/// A bounded newest-wins window over recorded events. `record` is O(1) and the
/// counters keep counting long after the window has started evicting.
#[derive(Debug)]
struct RetainedEvents<T> {
    capacity: usize,
    events: VecDeque<T>,
    total_recorded: u64,
    dropped: u64,
}

impl<T> RetainedEvents<T> {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            events: VecDeque::with_capacity(capacity.min(1_024)),
            total_recorded: 0,
            dropped: 0,
        }
    }

    fn record(&mut self, event: T) {
        self.total_recorded = self.total_recorded.saturating_add(1);
        if self.capacity == 0 {
            self.dropped = self.dropped.saturating_add(1);
            return;
        }
        if self.events.len() >= self.capacity {
            self.events.pop_front();
            self.dropped = self.dropped.saturating_add(1);
        }
        self.events.push_back(event);
    }

    fn stats(&self) -> RecorderStats {
        RecorderStats {
            capacity: self.capacity,
            retained: self.events.len(),
            total_recorded: self.total_recorded,
            dropped: self.dropped,
        }
    }
}

impl<T: Clone> RetainedEvents<T> {
    fn snapshot(&self) -> Vec<T> {
        self.events.iter().cloned().collect()
    }
}

/// The O(1) usage totals. They are the only usage numbers readiness reports, so
/// eviction can never make the service under-report what it spent.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct VoiceUsageAggregate {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    pub estimated_cost_usd: f64,
    pub invalid_cost_events: u64,
}

impl VoiceUsageAggregate {
    fn accumulate(&mut self, event: &VoiceUsageEvent) {
        let prompt = event
            .text_input_tokens
            .saturating_add(event.audio_input_tokens);
        let completion = event
            .text_output_tokens
            .saturating_add(event.audio_output_tokens);
        self.prompt_tokens = self.prompt_tokens.saturating_add(prompt);
        self.completion_tokens = self.completion_tokens.saturating_add(completion);
        self.total_tokens = self
            .total_tokens
            .saturating_add(prompt)
            .saturating_add(completion);
        if event.cost_estimate_usd.is_finite() && event.cost_estimate_usd >= 0.0 {
            self.estimated_cost_usd += event.cost_estimate_usd;
        } else {
            self.invalid_cost_events = self.invalid_cost_events.saturating_add(1);
        }
    }
}

/// `provider` and `model` are server-chosen identifiers, never learner text. A
/// value that is not a short identifier — a signed credential, a bearer header,
/// transcript prose, or a base64 audio blob — is replaced by this label before it
/// can be retained or rendered.
const REDACTED_USAGE_LABEL: &str = "redacted_usage_label";
const MAX_USAGE_LABEL_CHARS: usize = 64;

fn sanitized_usage_label(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let is_identifier = trimmed.chars().count() <= MAX_USAGE_LABEL_CHARS
        && trimmed.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | ':')
        });
    if !is_identifier {
        return REDACTED_USAGE_LABEL.to_owned();
    }
    if observe::sanitize_evidence_detail(trimmed.to_owned()) != trimmed {
        return REDACTED_USAGE_LABEL.to_owned();
    }
    trimmed.to_owned()
}

#[derive(Clone, Debug)]
pub struct VoiceEvidenceRecorder {
    retained: Arc<RwLock<RetainedEvents<VoiceEvidenceEvent>>>,
}

impl Default for VoiceEvidenceRecorder {
    fn default() -> Self {
        Self::with_capacity(RecorderLimits::default().evidence_events)
    }
}

impl VoiceEvidenceRecorder {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            retained: Arc::new(RwLock::new(RetainedEvents::new(capacity))),
        }
    }

    pub fn record(&self, event: VoiceEvidenceEvent) {
        self.retained
            .write()
            .expect("evidence recorder lock poisoned")
            .record(event);
    }

    pub fn snapshot(&self) -> Vec<VoiceEvidenceEvent> {
        self.retained
            .read()
            .expect("evidence recorder lock poisoned")
            .snapshot()
    }

    pub fn stats(&self) -> RecorderStats {
        self.retained
            .read()
            .expect("evidence recorder lock poisoned")
            .stats()
    }
}

#[derive(Debug)]
struct VoiceUsageState {
    retained: RetainedEvents<VoiceUsageEvent>,
    aggregate: VoiceUsageAggregate,
}

#[derive(Clone, Debug)]
pub struct VoiceUsageRecorder {
    state: Arc<RwLock<VoiceUsageState>>,
}

impl Default for VoiceUsageRecorder {
    fn default() -> Self {
        Self::with_capacity(RecorderLimits::default().usage_events)
    }
}

impl VoiceUsageRecorder {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            state: Arc::new(RwLock::new(VoiceUsageState {
                retained: RetainedEvents::new(capacity),
                aggregate: VoiceUsageAggregate::default(),
            })),
        }
    }

    pub fn record(
        &self,
        voice_session_id: Option<&str>,
        provider: &str,
        model: &str,
        usage: BrainUsage,
        duration_seconds: u64,
        answer_eval_latency_ms: Option<u64>,
    ) -> VoiceUsageRecord {
        let parsed_session_id = voice_session_id.and_then(|id| id.parse().ok());
        let cost_model = CostModel::default();
        let mut event = usage_event(
            parsed_session_id,
            sanitized_usage_label(provider),
            sanitized_usage_label(model),
            duration_seconds,
            usage,
            &cost_model,
        );
        event.answer_eval_latency_ms = answer_eval_latency_ms;
        let record = VoiceUsageRecord {
            voice_session_id: voice_session_id.map(ToOwned::to_owned),
            provider: event.provider.clone(),
            model: event.model.clone(),
            duration_seconds: event.duration_seconds,
            text_input_tokens: event.text_input_tokens,
            text_output_tokens: event.text_output_tokens,
            audio_input_tokens: event.audio_input_tokens,
            audio_output_tokens: event.audio_output_tokens,
            cost_estimate_usd: event.cost_estimate_usd,
            first_audio_latency_ms: event.first_audio_latency_ms,
            answer_eval_latency_ms: event.answer_eval_latency_ms,
            source_retrieval_latency_ms: event.source_retrieval_latency_ms,
            source_grounded_correction_count: event.source_grounded_correction_count,
        };
        // The aggregate is updated under the same lock, before eviction, so no
        // recorded event can be evicted without having been counted.
        let mut state = self.state.write().expect("usage recorder lock poisoned");
        state.aggregate.accumulate(&event);
        state.retained.record(event);
        record
    }

    pub fn snapshot(&self) -> Vec<VoiceUsageEvent> {
        self.state
            .read()
            .expect("usage recorder lock poisoned")
            .retained
            .snapshot()
    }

    pub fn stats(&self) -> RecorderStats {
        self.state
            .read()
            .expect("usage recorder lock poisoned")
            .retained
            .stats()
    }

    pub fn aggregate(&self) -> VoiceUsageAggregate {
        self.state
            .read()
            .expect("usage recorder lock poisoned")
            .aggregate
    }

    pub fn summary(&self) -> serde_json::Value {
        let state = self.state.read().expect("usage recorder lock poisoned");
        let stats = state.retained.stats();
        let aggregate = state.aggregate;
        drop(state);
        json!({
            "events": stats.retained,
            "prompt_tokens": aggregate.prompt_tokens,
            "completion_tokens": aggregate.completion_tokens,
            "total_tokens": aggregate.total_tokens,
            "estimated_cost_usd": aggregate.estimated_cost_usd,
            "invalid_cost_events": aggregate.invalid_cost_events,
            "retention": stats,
        })
    }
}

async fn root() -> Json<serde_json::Value> {
    Json(json!({
        "service": "viva-agent",
        "status": "ok",
    }))
}

async fn health(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    let response_headers = match optional_cors_json_headers(&state.ws_access, &headers) {
        Ok(headers) => headers,
        Err(error) => return cors_json_error(error),
    };
    (
        StatusCode::OK,
        response_headers,
        Json(json!({
            "ok": state.is_ready(),
            "live": true,
            "ready": state.is_ready(),
        })),
    )
}

async fn live(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    let response_headers = match optional_cors_json_headers(&state.ws_access, &headers) {
        Ok(headers) => headers,
        Err(error) => return cors_json_error(error),
    };
    (
        StatusCode::OK,
        response_headers,
        Json(json!({ "live": true })),
    )
}

async fn ready(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    let response_headers = match optional_cors_json_headers(&state.ws_access, &headers) {
        Ok(headers) => headers,
        Err(error) => return cors_json_error(error),
    };
    if let Err(error) = state.operator_access.validate(&headers) {
        return readiness_access_json_error(error, response_headers);
    }
    let brain = state.brain.capabilities();
    let store = state.study_store.capabilities();
    let writes = state.study_store.write_counts();
    let ready = state.is_ready();
    let readiness_status =
        readiness_status(ready, state.drain_signal.is_draining(), &brain, &store);
    let status = if ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        response_headers,
        Json(json!({
            "ready": ready,
            "readiness_status": readiness_status,
            "failure_kind": readiness_failure_kind(readiness_status),
            "access": {
                "status": "allowed",
            },
            "brain": {
                "provider": brain.provider,
                "configured": brain.configured,
                "selectable": brain.selectable,
                "live_runtime": brain.live_runtime,
            },
            "voice_limits": {
                "max_session_cost_usd": state.voice_limits.max_session_cost_usd,
            },
            "store": {
                "backend": store.backend.as_str(),
                "available": store.available,
                "durable": store.durable,
                "nonce_replay_protection": store.nonce_replay_protection,
                "raw_audio_persistence": store.raw_audio_persistence,
                "transcript_persistence": store.transcript_persistence,
                "uuid_schema_translation": store.uuid_schema_translation,
                "writes": {
                    "sessions": writes.sessions,
                    "answer_attempts": writes.answer_attempts,
                    "concept_statuses": writes.concept_statuses,
                    "review_items": writes.review_items,
                    "recaps": writes.recaps,
                },
            }
        })),
    )
}

async fn brain_health(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    let response_headers = match optional_cors_json_headers(&state.ws_access, &headers) {
        Ok(headers) => headers,
        Err(error) => return cors_json_error(error),
    };
    if let Err(error) = state.operator_access.validate(&headers) {
        return readiness_access_json_error(error, response_headers);
    }
    let brain = state.brain.capabilities();
    let store = state.study_store.capabilities();
    let writes = state.study_store.write_counts();
    let ready = state.is_ready();
    let readiness_status =
        readiness_status(ready, state.drain_signal.is_draining(), &brain, &store);

    (
        StatusCode::OK,
        response_headers,
        Json(json!({
            "provider": state.provider,
            "readiness_status": readiness_status,
            "failure_kind": readiness_failure_kind(readiness_status),
            "access": {
                "status": "allowed",
            },
            "brain": {
                "provider": brain.provider,
                "configured": brain.configured,
                "selectable": brain.selectable,
                "live_runtime": brain.live_runtime,
            },
            "voice_limits": {
                "max_session_cost_usd": state.voice_limits.max_session_cost_usd,
            },
            "store": {
                "backend": store.backend.as_str(),
                "available": store.available,
                "durable": store.durable,
                "nonce_replay_protection": store.nonce_replay_protection,
                "raw_audio_persistence": store.raw_audio_persistence,
                "transcript_persistence": store.transcript_persistence,
                "uuid_schema_translation": store.uuid_schema_translation,
                "writes": {
                    "sessions": writes.sessions,
                    "answer_attempts": writes.answer_attempts,
                    "concept_statuses": writes.concept_statuses,
                    "review_items": writes.review_items,
                    "recaps": writes.recaps,
                },
            },
            "usage": state.usage.summary(),
            "evidence": state.evidence.stats(),
            "status": if ready {
                "configured"
            } else {
                "unavailable"
            },
        })),
    )
}

fn readiness_status(
    ready: bool,
    draining: bool,
    brain: &agent_domain::RealtimeBrainCapabilities,
    store: &agent_domain::StudyStoreCapabilities,
) -> &'static str {
    if ready {
        return "ready";
    }
    if draining {
        return "draining";
    }
    if !brain.configured {
        return "provider_unconfigured";
    }
    if !brain.selectable {
        return "provider_unselectable";
    }
    if !store.available {
        return "store_unavailable";
    }
    "dependency_unavailable"
}

fn readiness_failure_kind(readiness_status: &str) -> &'static str {
    match readiness_status {
        "ready" => "none",
        "draining" => "service_draining",
        "access_denied" => "access_denied",
        _ => "dependency_unavailable",
    }
}

fn readiness_access_json_error(
    error: crate::config::VoiceWsAccessError,
    response_headers: HeaderMap,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    (
        access_error_status(&error),
        response_headers,
        Json(json!({
            "error": access_error_code(&error),
            "message": error.to_string(),
            "readiness_status": "access_denied",
            "failure_kind": readiness_failure_kind("access_denied"),
            "access": {
                "status": "denied",
                "reason": access_error_code(&error),
            },
        })),
    )
}

fn access_error_status(error: &crate::config::VoiceWsAccessError) -> StatusCode {
    match error {
        crate::config::VoiceWsAccessError::OriginDenied => StatusCode::FORBIDDEN,
        crate::config::VoiceWsAccessError::MissingBearer
        | crate::config::VoiceWsAccessError::InvalidBearer => StatusCode::UNAUTHORIZED,
    }
}

fn access_error_code(error: &crate::config::VoiceWsAccessError) -> &'static str {
    match error {
        crate::config::VoiceWsAccessError::OriginDenied => "origin_denied",
        crate::config::VoiceWsAccessError::MissingBearer => "missing_bearer",
        crate::config::VoiceWsAccessError::InvalidBearer => "invalid_bearer",
    }
}

#[derive(Clone, Debug, Deserialize)]
struct PasteStudySetRequest {
    title: String,
    course: Option<String>,
    exam_date: Option<String>,
    pasted_text: String,
}

#[derive(Clone, Debug, Deserialize)]
struct FileStudySetRequest {
    title: String,
    course: Option<String>,
    exam_date: Option<String>,
    file_name: String,
    content_type: Option<String>,
    file_base64: String,
}

#[derive(Clone, Debug, Deserialize)]
struct RetryFileStudySetRequest {
    file_name: String,
    content_type: Option<String>,
    file_base64: String,
}

#[derive(Clone, Debug, Serialize)]
struct PasteStudySetResponse {
    #[serde(flatten)]
    record: StudySetIngestionRecord,
}

#[derive(Clone, Debug, Deserialize)]
struct LibrarySnapshotQuery {
    user_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
struct LibrarySnapshotResponse {
    user_id: String,
    privacy: LibraryPrivacyResponse,
    study_sets: Vec<LibraryStudySetResponse>,
    sessions: Vec<LibrarySessionSummary>,
}

#[derive(Clone, Debug, Serialize)]
struct LibraryExportResponse {
    user_id: String,
    privacy: LibraryPrivacyResponse,
    study_sets: Vec<LibraryExportStudySetResponse>,
    sessions: Vec<LibrarySessionSummary>,
}

#[derive(Clone, Debug, Serialize)]
struct LibraryPrivacyResponse {
    voice_recordings_saved: bool,
    transcripts_saved: bool,
    raw_audio_persistence: bool,
    transcript_persistence: bool,
    export_contains_raw_provider_payloads: bool,
    export: LibraryAction,
    copy: &'static str,
    data_handling_statement: &'static str,
    retention_statement: &'static str,
    deletion_statement: &'static str,
}

#[derive(Clone, Debug, Serialize)]
struct LibraryStudySetResponse {
    id: String,
    user_id: String,
    title: String,
    course: Option<String>,
    ingestion_status: StudySetIngestionStatus,
    ingestion_error: Option<String>,
    server_owned: bool,
    documents: Vec<LibraryStudyDocumentSummary>,
    concept_count: usize,
    question_count: usize,
    actions: LibraryStudySetActions,
}

#[derive(Clone, Debug, Serialize)]
struct LibraryExportStudySetResponse {
    id: String,
    user_id: String,
    title: String,
    course: Option<String>,
    ingestion_status: StudySetIngestionStatus,
    ingestion_error: Option<String>,
    server_owned: bool,
    documents: Vec<LibraryStudyDocumentSummary>,
    concept_count: usize,
    question_count: usize,
}

#[derive(Clone, Debug, Serialize)]
struct LibraryStudySetActions {
    start: LibraryAction,
    resume: LibraryAction,
    archive: LibraryAction,
    delete: LibraryAction,
}

#[derive(Clone, Debug, Serialize)]
struct LibraryAction {
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    control_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unavailable_reason: Option<&'static str>,
}

async fn paste_options(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
) -> (StatusCode, HeaderMap) {
    match cors_headers(&state.ws_access, headers.get(header::ORIGIN)) {
        Ok(headers) => (StatusCode::NO_CONTENT, headers),
        Err(_) => (StatusCode::FORBIDDEN, HeaderMap::new()),
    }
}

async fn library_snapshot(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<LibrarySnapshotQuery>,
    headers: HeaderMap,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    let response_headers = match optional_cors_json_headers(&state.ws_access, &headers) {
        Ok(headers) => headers,
        Err(error) => return cors_json_error(error),
    };
    let user_id = query
        .user_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&state.trusted_user_id);
    if !state.unauthenticated_paste_allowed || user_id != state.trusted_user_id {
        if state.ws_access.required_bearer.is_none() {
            return (
                StatusCode::FORBIDDEN,
                response_headers,
                Json(json!({
                    "error": "library_snapshot_auth_required",
                    "message": "cross-user library snapshots require authenticated REST access",
                })),
            );
        }
        if let Err(error) = state.ws_access.validate_bearer_headers(&headers) {
            return (
                StatusCode::UNAUTHORIZED,
                response_headers,
                Json(json!({
                    "error": "library_snapshot_auth_failed",
                    "message": error.to_string(),
                })),
            );
        }
    }
    let snapshot = match state.study_store.library_snapshot(user_id).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                response_headers,
                Json(json!({
                    "error": "library_snapshot_failed",
                    "message": error.to_string(),
                })),
            );
        }
    };
    let request_origin = request_origin(&headers).map(ToOwned::to_owned);
    let study_sets = snapshot
        .study_sets
        .into_iter()
        .map(|study_set| {
            let mutation_control_token = signed_library_control_token(&state, &study_set.user_id);
            let unavailable_reason = study_set_start_unavailable_reason(&study_set);
            let start = match unavailable_reason {
                Some(reason) => unavailable_action(reason),
                None => {
                    let session_id = Uuid::new_v4().to_string();
                    signed_library_action(
                        &state,
                        &study_set.user_id,
                        &study_set.id,
                        session_id,
                        request_origin.as_deref(),
                    )
                }
            };
            let resume = match (unavailable_reason, study_set.open_session_id.clone()) {
                (Some(reason), _) => unavailable_action(reason),
                (None, Some(session_id)) => signed_library_action(
                    &state,
                    &study_set.user_id,
                    &study_set.id,
                    session_id,
                    request_origin.as_deref(),
                ),
                (None, None) => unavailable_action("no_open_session"),
            };
            let mutation_auth_unavailable_reason =
                library_mutation_access_unavailable_reason(&state, &headers, &study_set.user_id);
            let delete = if let Some(reason) = mutation_auth_unavailable_reason {
                unavailable_action(reason)
            } else if mutation_control_token.is_none() {
                unavailable_action("control_token_unavailable")
            } else if study_set.server_owned
                && !study_set.documents.is_empty()
                && study_set.documents.iter().any(|document| !document.deleted)
            {
                available_mutation_action(mutation_control_token.clone())
            } else {
                unavailable_action(unavailable_reason.unwrap_or("source_deleted"))
            };

            LibraryStudySetResponse {
                id: study_set.id,
                user_id: study_set.user_id,
                title: study_set.title,
                course: study_set.course,
                ingestion_status: study_set.ingestion_status,
                ingestion_error: study_set.ingestion_error,
                server_owned: study_set.server_owned,
                documents: study_set.documents,
                concept_count: study_set.concept_count,
                question_count: study_set.question_count,
                actions: LibraryStudySetActions {
                    start,
                    resume,
                    archive: unavailable_action("server_mutation_unavailable"),
                    delete,
                },
            }
        })
        .collect::<Vec<_>>();

    (
        StatusCode::OK,
        response_headers,
        Json(
            serde_json::to_value(LibrarySnapshotResponse {
                user_id: snapshot.user_id,
                privacy: privacy_response_for_headers(&state, &headers, user_id),
                study_sets,
                sessions: snapshot.sessions,
            })
            .unwrap_or_else(|error| {
                json!({
                    "error": "library_response_failed",
                    "message": error.to_string(),
                })
            }),
        ),
    )
}

async fn library_export(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<LibrarySnapshotQuery>,
    headers: HeaderMap,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    let response_headers = match optional_cors_json_headers(&state.ws_access, &headers) {
        Ok(headers) => headers,
        Err(error) => return cors_json_error(error),
    };
    let user_id = requested_library_user_id(&query, &state);
    if let Some(error) = require_library_control_access(
        &state,
        &headers,
        &response_headers,
        &user_id,
        "library_export",
    ) {
        return error;
    }
    let snapshot = match state.study_store.library_snapshot(&user_id).await {
        Ok(snapshot) => snapshot,
        Err(error) => return store_json_error(response_headers, error, "library_export_failed"),
    };
    let study_sets = snapshot
        .study_sets
        .into_iter()
        .map(|study_set| LibraryExportStudySetResponse {
            id: study_set.id,
            user_id: study_set.user_id,
            title: study_set.title,
            course: study_set.course,
            ingestion_status: study_set.ingestion_status,
            ingestion_error: study_set.ingestion_error,
            server_owned: study_set.server_owned,
            documents: study_set.documents,
            concept_count: study_set.concept_count,
            question_count: study_set.question_count,
        })
        .collect();

    (
        StatusCode::OK,
        response_headers,
        Json(
            serde_json::to_value(LibraryExportResponse {
                user_id: snapshot.user_id,
                privacy: privacy_response(&state, available_mutation_action(None)),
                study_sets,
                sessions: snapshot.sessions,
            })
            .unwrap_or_else(|error| {
                json!({
                    "error": "library_export_response_failed",
                    "message": error.to_string(),
                })
            }),
        ),
    )
}

async fn delete_study_set(
    axum::extract::State(state): axum::extract::State<AppState>,
    Path(study_set_id): Path<String>,
    Query(query): Query<LibrarySnapshotQuery>,
    headers: HeaderMap,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    let response_headers = match optional_cors_json_headers(&state.ws_access, &headers) {
        Ok(headers) => headers,
        Err(error) => return cors_json_error(error),
    };
    let user_id = requested_library_user_id(&query, &state);
    if let Some(error) = require_library_control_access(
        &state,
        &headers,
        &response_headers,
        &user_id,
        "study_set_delete",
    ) {
        return error;
    }

    match state
        .study_store
        .delete_study_set(&user_id, &study_set_id)
        .await
    {
        Ok(result) => (StatusCode::OK, response_headers, Json(result)),
        Err(error) => store_json_error(response_headers, error, "study_set_delete_failed"),
    }
}

async fn delete_session_history(
    axum::extract::State(state): axum::extract::State<AppState>,
    Path((study_set_id, voice_session_id)): Path<(String, String)>,
    Query(query): Query<LibrarySnapshotQuery>,
    headers: HeaderMap,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    let response_headers = match optional_cors_json_headers(&state.ws_access, &headers) {
        Ok(headers) => headers,
        Err(error) => return cors_json_error(error),
    };
    let user_id = requested_library_user_id(&query, &state);
    if let Some(error) = require_library_control_access(
        &state,
        &headers,
        &response_headers,
        &user_id,
        "session_delete",
    ) {
        return error;
    }

    match state
        .study_store
        .delete_session_history(&user_id, &study_set_id, &voice_session_id)
        .await
    {
        Ok(result) => (StatusCode::OK, response_headers, Json(result)),
        Err(error) => store_json_error(response_headers, error, "session_delete_failed"),
    }
}

async fn create_paste_study_set(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    Json(request): Json<PasteStudySetRequest>,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    let mut response_headers = match cors_headers(&state.ws_access, headers.get(header::ORIGIN)) {
        Ok(headers) => headers,
        Err(error) => {
            return (
                StatusCode::FORBIDDEN,
                HeaderMap::new(),
                Json(json!({
                    "error": "origin_denied",
                    "message": error.to_string(),
                })),
            );
        }
    };
    response_headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    if !state.unauthenticated_paste_allowed {
        if state.ws_access.required_bearer.is_none() {
            return (
                StatusCode::FORBIDDEN,
                response_headers,
                Json(json!({
                    "error": "paste_ingestion_auth_required",
                    "message": "paste ingestion token minting is disabled without authenticated REST access",
                })),
            );
        }
        if let Err(error) = state.ws_access.validate_bearer_headers(&headers) {
            return (
                StatusCode::UNAUTHORIZED,
                response_headers,
                Json(json!({
                    "error": "paste_ingestion_auth_failed",
                    "message": error.to_string(),
                })),
            );
        }
    }

    let session_id = Uuid::new_v4().to_string();
    let input = CreatePasteStudySet {
        user_id: state.trusted_user_id.clone(),
        title: request.title,
        course: request.course,
        exam_date: request.exam_date,
        pasted_text: request.pasted_text,
        session_id: Some(session_id),
    };
    let mut record = match state.study_store.create_paste_study_set(input).await {
        Ok(record) => record,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                response_headers,
                Json(json!({
                    "error": "paste_ingestion_failed",
                    "message": error.to_string(),
                })),
            );
        }
    };
    if let Err(error) = attach_ready_session_token(&state, &mut record, request_origin(&headers)) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            response_headers,
            Json(json!({
                "error": "session_token_failed",
                "message": error.to_string(),
            })),
        );
    }
    (
        StatusCode::CREATED,
        response_headers,
        Json(
            serde_json::to_value(PasteStudySetResponse { record }).unwrap_or_else(|error| {
                json!({
                    "error": "paste_response_failed",
                    "message": error.to_string(),
                })
            }),
        ),
    )
}

async fn create_file_study_set(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    Json(request): Json<FileStudySetRequest>,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    let mut response_headers = match cors_headers(&state.ws_access, headers.get(header::ORIGIN)) {
        Ok(headers) => headers,
        Err(error) => {
            return (
                StatusCode::FORBIDDEN,
                HeaderMap::new(),
                Json(json!({
                    "error": "origin_denied",
                    "message": error.to_string(),
                })),
            );
        }
    };
    response_headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    if !state.unauthenticated_paste_allowed {
        if state.ws_access.required_bearer.is_none() {
            return (
                StatusCode::FORBIDDEN,
                response_headers,
                Json(json!({
                    "error": "file_ingestion_auth_required",
                    "message": "file ingestion token minting is disabled without authenticated REST access",
                })),
            );
        }
        if let Err(error) = state.ws_access.validate_bearer_headers(&headers) {
            return (
                StatusCode::UNAUTHORIZED,
                response_headers,
                Json(json!({
                    "error": "file_ingestion_auth_failed",
                    "message": error.to_string(),
                })),
            );
        }
    }

    let file_bytes = match STANDARD.decode(request.file_base64.as_bytes()) {
        Ok(bytes) => bytes,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                response_headers,
                Json(json!({
                    "error": "file_ingestion_failed",
                    "message": format!("invalid file_base64: {error}"),
                })),
            );
        }
    };
    let session_id = Uuid::new_v4().to_string();
    let input = CreateFileStudySet {
        user_id: state.trusted_user_id.clone(),
        study_set_id: None,
        title: request.title,
        course: request.course,
        exam_date: request.exam_date,
        file_name: request.file_name,
        content_type: request.content_type,
        file_bytes,
        session_id: Some(session_id),
    };
    let mut record = match state.study_store.create_file_study_set(input).await {
        Ok(record) => record,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                response_headers,
                Json(json!({
                    "error": "file_ingestion_failed",
                    "message": error.to_string(),
                })),
            );
        }
    };
    if let Err(error) = attach_ready_session_token(&state, &mut record, request_origin(&headers)) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            response_headers,
            Json(json!({
                "error": "session_token_failed",
                "message": error.to_string(),
            })),
        );
    }
    (
        StatusCode::CREATED,
        response_headers,
        Json(
            serde_json::to_value(PasteStudySetResponse { record }).unwrap_or_else(|error| {
                json!({
                    "error": "file_response_failed",
                    "message": error.to_string(),
                })
            }),
        ),
    )
}

async fn retry_file_study_set(
    axum::extract::State(state): axum::extract::State<AppState>,
    Path(study_set_id): Path<String>,
    Query(query): Query<LibrarySnapshotQuery>,
    headers: HeaderMap,
    Json(request): Json<RetryFileStudySetRequest>,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    let response_headers = match optional_cors_json_headers(&state.ws_access, &headers) {
        Ok(headers) => headers,
        Err(error) => return cors_json_error(error),
    };
    let user_id = requested_library_user_id(&query, &state);
    if let Some(error) =
        require_library_control_access(&state, &headers, &response_headers, &user_id, "file_retry")
    {
        return error;
    }
    let file_bytes = match STANDARD.decode(request.file_base64.as_bytes()) {
        Ok(bytes) => bytes,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                response_headers,
                Json(json!({
                    "error": "file_retry_failed",
                    "message": format!("invalid file_base64: {error}"),
                })),
            );
        }
    };
    let session_id = Uuid::new_v4().to_string();
    let input = CreateFileStudySet {
        user_id,
        study_set_id: Some(study_set_id),
        title: String::new(),
        course: None,
        exam_date: None,
        file_name: request.file_name,
        content_type: request.content_type,
        file_bytes,
        session_id: Some(session_id),
    };
    let mut record = match state.study_store.retry_file_study_set(input).await {
        Ok(record) => record,
        Err(error) => return store_json_error(response_headers, error, "file_retry_failed"),
    };
    if let Err(error) = attach_ready_session_token(&state, &mut record, request_origin(&headers)) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            response_headers,
            Json(json!({
                "error": "session_token_failed",
                "message": error.to_string(),
            })),
        );
    }
    (
        StatusCode::OK,
        response_headers,
        Json(
            serde_json::to_value(PasteStudySetResponse { record }).unwrap_or_else(|error| {
                json!({
                    "error": "file_retry_response_failed",
                    "message": error.to_string(),
                })
            }),
        ),
    )
}

fn attach_ready_session_token(
    state: &AppState,
    record: &mut StudySetIngestionRecord,
    origin: Option<&str>,
) -> Result<(), crate::config::SessionTokenError> {
    if record.study_set.ingestion_status == StudySetIngestionStatus::Ready {
        if let Some(secret) = state
            .ws_access
            .session_token_secret
            .as_ref()
            .map(RedactedSecret::as_str)
        {
            record.session_token = Some(signed_session_token(record, secret, state, origin)?);
        }
    }
    Ok(())
}

fn study_set_start_unavailable_reason(study_set: &LibraryStudySetSummary) -> Option<&'static str> {
    if !study_set.server_owned {
        return Some("not_server_owned");
    }
    match study_set.ingestion_status {
        StudySetIngestionStatus::Pending => return Some("ingestion_pending"),
        StudySetIngestionStatus::Processing => return Some("ingestion_processing"),
        StudySetIngestionStatus::Retry => return Some("ingestion_retry"),
        StudySetIngestionStatus::Failed => return Some("ingestion_failed"),
        StudySetIngestionStatus::Ready => {}
    }
    if !study_set.documents.is_empty()
        && study_set.documents.iter().all(|document| document.deleted)
    {
        return Some("source_deleted");
    }
    if study_set.question_count == 0 {
        return Some("no_active_questions");
    }
    None
}

fn unavailable_action(reason: &'static str) -> LibraryAction {
    LibraryAction {
        available: false,
        session_id: None,
        session_token: None,
        control_token: None,
        unavailable_reason: Some(reason),
    }
}

fn available_mutation_action(control_token: Option<String>) -> LibraryAction {
    LibraryAction {
        available: true,
        session_id: None,
        session_token: None,
        control_token,
        unavailable_reason: None,
    }
}

fn signed_library_action(
    state: &AppState,
    user_id: &str,
    study_set_id: &str,
    session_id: String,
    origin: Option<&str>,
) -> LibraryAction {
    let Some(secret) = state
        .ws_access
        .session_token_secret
        .as_ref()
        .map(RedactedSecret::as_str)
    else {
        return unavailable_action("session_token_unavailable");
    };
    let Ok(failure_control) =
        failure_control_claim_for(state, user_id, study_set_id, &session_id, origin)
    else {
        return unavailable_action("session_token_unavailable");
    };
    let Ok(session_token) =
        signed_session_token_for(user_id, study_set_id, &session_id, secret, failure_control)
    else {
        return unavailable_action("session_token_unavailable");
    };
    LibraryAction {
        available: true,
        session_id: Some(session_id),
        session_token: Some(session_token),
        control_token: None,
        unavailable_reason: None,
    }
}

fn signed_library_control_token(state: &AppState, user_id: &str) -> Option<String> {
    let secret = state
        .ws_access
        .session_token_secret
        .as_ref()
        .map(RedactedSecret::as_str)?;
    signed_session_token_for(
        user_id,
        "__library_control__",
        &Uuid::new_v4().to_string(),
        secret,
        None,
    )
    .ok()
}

fn signed_session_token(
    record: &StudySetIngestionRecord,
    secret: &str,
    state: &AppState,
    origin: Option<&str>,
) -> Result<String, crate::config::SessionTokenError> {
    let failure_control = failure_control_claim_for(
        state,
        &record.study_set.user_id,
        &record.study_set.id,
        &record.session_id,
        origin,
    )?;
    signed_session_token_for(
        &record.study_set.user_id,
        &record.study_set.id,
        &record.session_id,
        secret,
        failure_control,
    )
}

fn signed_session_token_for(
    user_id: &str,
    study_set_id: &str,
    session_id: &str,
    secret: &str,
    failure_control: Option<FailureControlClaim>,
) -> Result<String, crate::config::SessionTokenError> {
    let expires_at = unix_timestamp_now().unwrap_or(0) + 15 * 60;
    SessionTokenClaims {
        user_id: user_id.to_owned(),
        study_set_id: study_set_id.to_owned(),
        session_id: session_id.to_owned(),
        expires_at,
        nonce: Uuid::new_v4().to_string(),
        failure_control,
    }
    .sign(secret)
}

fn failure_control_claim_for(
    state: &AppState,
    user_id: &str,
    study_set_id: &str,
    session_id: &str,
    origin: Option<&str>,
) -> Result<Option<FailureControlClaim>, crate::config::SessionTokenError> {
    if !state.failure_control.enabled() {
        return Ok(None);
    }
    let Some(origin) = origin.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if !state
        .failure_control
        .allows_identity(user_id, study_set_id, origin)
    {
        return Ok(None);
    }
    let now = unix_timestamp_now()?;
    let run_id = Uuid::new_v4().to_string();
    let nonce = Uuid::new_v4().to_string();
    Ok(Some(state.failure_control.signed_claim_for(
        FailureControlClaimRequest {
            user_id,
            study_set_id,
            session_id,
            origin,
            run_id: &run_id,
            now,
            nonce: &nonce,
        },
    )?))
}

fn request_origin(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn unix_timestamp_now() -> Result<u64, crate::config::SessionTokenError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| crate::config::SessionTokenError::Invalid)
}

fn requested_library_user_id(query: &LibrarySnapshotQuery, state: &AppState) -> String {
    query
        .user_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&state.trusted_user_id)
        .to_owned()
}

fn require_library_control_access(
    state: &AppState,
    headers: &HeaderMap,
    response_headers: &HeaderMap,
    user_id: &str,
    operation: &'static str,
) -> Option<(StatusCode, HeaderMap, Json<serde_json::Value>)> {
    if state.ws_access.required_bearer.is_none() && state.ws_access.session_token_secret.is_none() {
        return Some((
            StatusCode::FORBIDDEN,
            response_headers.clone(),
            Json(json!({
                "error": format!("{operation}_auth_required"),
                "message": "library export and deletion controls require authenticated REST access",
            })),
        ));
    }
    if state.ws_access.required_bearer.is_some()
        && state.ws_access.validate_bearer_headers(headers).is_ok()
    {
        return None;
    }
    if validate_library_control_token(state, headers, user_id).is_ok() {
        return None;
    }
    let message = if headers.get("x-viva-library-control-token").is_some() {
        "invalid library control token"
    } else {
        "missing bearer token or library control token"
    };
    Some((
        StatusCode::UNAUTHORIZED,
        response_headers.clone(),
        Json(json!({
            "error": format!("{operation}_auth_failed"),
            "message": message,
        })),
    ))
}

fn validate_library_control_token(
    state: &AppState,
    headers: &HeaderMap,
    user_id: &str,
) -> Result<(), crate::config::SessionTokenError> {
    let secret = state
        .ws_access
        .session_token_secret
        .as_ref()
        .map(RedactedSecret::as_str)
        .ok_or(crate::config::SessionTokenError::Invalid)?;
    let token = headers
        .get("x-viva-library-control-token")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(crate::config::SessionTokenError::Malformed)?;
    let claims = SessionTokenClaims::verify(token, secret)?;
    if claims.user_id != user_id || claims.study_set_id != "__library_control__" {
        return Err(crate::config::SessionTokenError::Invalid);
    }
    Ok(())
}

fn library_mutation_access_unavailable_reason(
    state: &AppState,
    headers: &HeaderMap,
    user_id: &str,
) -> Option<&'static str> {
    if state.ws_access.required_bearer.is_some()
        && state.ws_access.validate_bearer_headers(headers).is_ok()
    {
        return None;
    }
    if validate_library_control_token(state, headers, user_id).is_ok() {
        return None;
    }
    Some("mutation_auth_required")
}

fn privacy_response_for_headers(
    state: &AppState,
    headers: &HeaderMap,
    user_id: &str,
) -> LibraryPrivacyResponse {
    let export = match library_mutation_access_unavailable_reason(state, headers, user_id) {
        Some(reason) => unavailable_action(reason),
        None => match signed_library_control_token(state, user_id) {
            Some(token) => available_mutation_action(Some(token)),
            None => unavailable_action("control_token_unavailable"),
        },
    };
    privacy_response(state, export)
}

fn privacy_response(state: &AppState, export: LibraryAction) -> LibraryPrivacyResponse {
    let store = state.study_store.capabilities();
    LibraryPrivacyResponse {
        voice_recordings_saved: store.raw_audio_persistence,
        transcripts_saved: store.transcript_persistence,
        raw_audio_persistence: store.raw_audio_persistence,
        transcript_persistence: store.transcript_persistence,
        export_contains_raw_provider_payloads: false,
        export,
        copy: if store.raw_audio_persistence || store.transcript_persistence {
            "Voice recordings or transcripts may be persisted by this configured store."
        } else {
            "Voice recordings and transcripts are not saved; Viva stores sanitized study meaning only."
        },
        data_handling_statement: "Viva records sanitized study-set records, source summaries, session status, recaps, review items, usage rows, answer-attempt envelopes, and nonce rows; this configured store does not retain raw microphone audio or raw transcripts.",
        retention_statement: "Durable Postgres rows remain until the tester deletes the session recap or the study set; local in-memory rows expire with the process.",
        deletion_statement: "Delete recap removes the session recap, review items, usage rows, answer-attempt envelopes, and nonce rows while marking the session deleted. Delete source tombstones source material and purges the set's session artifacts.",
    }
}

fn store_json_error(
    response_headers: HeaderMap,
    error: PortError,
    error_code: &'static str,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    // `PortErrorKind` is the only classifier; `reason()` is diagnostics and is
    // never branched on. `Unavailable` keeps the historical "no such record"
    // status; every other typed kind is a server-side fault.
    let status = match error.kind() {
        PortErrorKind::Unavailable => StatusCode::NOT_FOUND,
        PortErrorKind::InvalidInput
        | PortErrorKind::Conflict
        | PortErrorKind::Durability
        | PortErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (
        status,
        response_headers,
        Json(json!({
            "error": error_code,
            "message": error.to_string(),
        })),
    )
}

fn optional_cors_json_headers(
    access: &VoiceWsAccess,
    request_headers: &HeaderMap,
) -> Result<HeaderMap, crate::config::VoiceWsAccessError> {
    let mut headers = request_headers.get(header::ORIGIN).map_or_else(
        || Ok(HeaderMap::new()),
        |origin| cors_headers(access, Some(origin)),
    )?;
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    Ok(headers)
}

fn cors_json_error(
    error: crate::config::VoiceWsAccessError,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    (
        access_error_status(&error),
        HeaderMap::new(),
        Json(json!({
            "error": access_error_code(&error),
            "message": error.to_string(),
            "readiness_status": "access_denied",
            "failure_kind": readiness_failure_kind("access_denied"),
            "access": {
                "status": "denied",
                "reason": access_error_code(&error),
            },
        })),
    )
}

fn cors_headers(
    access: &VoiceWsAccess,
    origin: Option<&HeaderValue>,
) -> Result<HeaderMap, crate::config::VoiceWsAccessError> {
    let mut headers = HeaderMap::new();
    let allow_origin = if access.allowed_origins.is_empty() {
        origin
            .cloned()
            .unwrap_or_else(|| HeaderValue::from_static("*"))
    } else {
        let origin = origin.ok_or(crate::config::VoiceWsAccessError::OriginDenied)?;
        let origin_text = origin
            .to_str()
            .map_err(|_| crate::config::VoiceWsAccessError::OriginDenied)?;
        if !access
            .allowed_origins
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(origin_text))
        {
            return Err(crate::config::VoiceWsAccessError::OriginDenied);
        }
        origin.clone()
    };
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, allow_origin);
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, DELETE, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("content-type, authorization, x-viva-library-control-token"),
    );
    headers.insert(header::VARY, HeaderValue::from_static("origin"));
    Ok(headers)
}
