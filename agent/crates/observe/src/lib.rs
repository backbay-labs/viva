#![forbid(unsafe_code)]

use agent_domain::BrainUsage;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const REDACTED_EVIDENCE_DETAIL: &str = "redacted_evidence_detail";
const AUTH_FAILURE_TERMINAL_REASON: &str = concat!("invalid", "_session", "_token");
const NONCE_STORE_UNAVAILABLE_TERMINAL_REASON: &str =
    concat!("session", "_token", "_nonce", "_store", "_unavailable");
const DEFAULT_EVIDENCE_DETAIL_MAX_CHARS: usize = 240;
const PROVIDER_STAGE_FAILURE_EVIDENCE_DETAIL_MAX_CHARS: usize = 384;
const SAFE_EVIDENCE_DETAIL_LITERALS: &[&str] = &[
    AUTH_FAILURE_TERMINAL_REASON,
    NONCE_STORE_UNAVAILABLE_TERMINAL_REASON,
];
const FORBIDDEN_EVIDENCE_DETAIL_MARKERS: &[&str] = &[
    "pcm16_base64",
    "answer_text",
    "answertext",
    "transcript_final",
    "transcriptfinal",
    "source_context",
    "sourcecontext",
    "pasted_text",
    "pastedtext",
    "session_token",
    "viva1.",
    "bearer ",
    "bearer.",
    "cartesia_api_key",
    "gemini_api_key",
    "raw answer",
    "raw_answer_text",
    "rawanswertext",
    "raw_audio",
    "rawaudio",
    "raw_transcript",
    "rawtranscript",
    "prompt_content",
    "promptcontent",
    "source excerpt",
    "source_excerpt_text",
    "sourceexcerpttext",
];

const FORBIDDEN_EVIDENCE_DETAIL_FIELDS: &[&str] = &[
    "api_key",
    "apikey",
    "authorization",
    "bearer",
    "control_token",
    "controltoken",
    "password",
    "secret",
    "token",
];

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceEvidenceEventKind {
    AuthFailure,
    PreflightAccepted,
    PreflightRejected,
    ConfigAccepted,
    SessionOpened,
    QuestionEmitted,
    AnswerReceived,
    EvaluationEmitted,
    SourceEmitted,
    CancelReceived,
    StopReceived,
    Close,
    StoreCounts,
    TerminalReason,
    ProviderStageFailure,
    ProviderAdmission,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct VoiceEvidenceEvent {
    pub kind: VoiceEvidenceEventKind,
    pub voice_session_id: Option<String>,
    pub detail: String,
}

impl VoiceEvidenceEvent {
    pub fn new(
        kind: VoiceEvidenceEventKind,
        voice_session_id: Option<String>,
        detail: impl Into<String>,
    ) -> Self {
        let detail = sanitize_evidence_detail_for_kind(&kind, detail.into());
        Self {
            kind,
            voice_session_id,
            detail,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SanitizedEvidenceDetail(String);

impl SanitizedEvidenceDetail {
    pub fn from_raw(detail: impl Into<String>) -> Self {
        Self::from_raw_with_max(detail, DEFAULT_EVIDENCE_DETAIL_MAX_CHARS)
    }

    fn from_raw_with_max(detail: impl Into<String>, max_chars: usize) -> Self {
        let detail = detail.into();
        if SAFE_EVIDENCE_DETAIL_LITERALS.contains(&detail.as_str()) {
            return Self(detail);
        }
        if contains_forbidden_evidence_detail_marker(&detail) {
            return Self(REDACTED_EVIDENCE_DETAIL.to_owned());
        }
        Self(
            detail
                .chars()
                .filter(|character| {
                    character.is_ascii_alphanumeric()
                        || matches!(
                            character,
                            ' ' | '-' | '_' | ':' | '.' | '/' | '=' | ',' | ';' | '(' | ')'
                        )
                })
                .take(max_chars)
                .collect(),
        )
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct VoiceEvidenceStoreCounts {
    pub sessions: usize,
    pub answer_attempts: usize,
    pub concept_statuses: usize,
    pub review_items: usize,
    pub recaps: usize,
}

pub fn sanitize_evidence_detail(detail: String) -> String {
    SanitizedEvidenceDetail::from_raw(detail).into_string()
}

fn sanitize_evidence_detail_for_kind(kind: &VoiceEvidenceEventKind, detail: String) -> String {
    let max_chars = match kind {
        VoiceEvidenceEventKind::ProviderStageFailure => {
            PROVIDER_STAGE_FAILURE_EVIDENCE_DETAIL_MAX_CHARS
        }
        _ => DEFAULT_EVIDENCE_DETAIL_MAX_CHARS,
    };
    SanitizedEvidenceDetail::from_raw_with_max(detail, max_chars).into_string()
}

fn contains_forbidden_evidence_detail_marker(detail: &str) -> bool {
    let normalized = detail.to_ascii_lowercase();
    let marker_hit = FORBIDDEN_EVIDENCE_DETAIL_MARKERS
        .iter()
        .any(|marker| normalized.contains(marker));
    if marker_hit {
        return true;
    }
    let field_scan = normalized
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '_' | '-' | '.' | '=' | ':' | '"')
        })
        .collect::<String>();
    FORBIDDEN_EVIDENCE_DETAIL_FIELDS
        .iter()
        .any(|field| detail_field_assignment_present(&field_scan, field))
}

fn detail_field_assignment_present(detail: &str, field: &str) -> bool {
    [
        format!("{field}="),
        format!("{field}:"),
        format!("\"{field}\""),
    ]
    .iter()
    .any(|marker| detail.contains(marker))
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VoiceUsageEvent {
    pub id: Uuid,
    pub voice_session_id: Option<Uuid>,
    pub provider: String,
    pub model: String,
    pub duration_seconds: u64,
    pub text_input_tokens: u64,
    pub text_output_tokens: u64,
    pub audio_input_tokens: u64,
    pub audio_output_tokens: u64,
    pub cost_estimate_usd: f64,
    pub first_audio_latency_ms: Option<u64>,
    pub answer_eval_latency_ms: Option<u64>,
    pub source_retrieval_latency_ms: Option<u64>,
    pub source_grounded_correction_count: u64,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CostModel {
    pub input_milli_cents_per_1k_tokens: u64,
    pub output_milli_cents_per_1k_tokens: u64,
}

impl Default for CostModel {
    fn default() -> Self {
        Self {
            input_milli_cents_per_1k_tokens: 25,
            output_milli_cents_per_1k_tokens: 75,
        }
    }
}

impl CostModel {
    pub fn estimate_milli_cents(&self, usage: &BrainUsage) -> u64 {
        let input_tokens = usage
            .audio_input_tokens
            .saturating_add(usage.text_input_tokens)
            .saturating_sub(
                usage
                    .cached_audio_input_tokens
                    .saturating_add(usage.cached_text_input_tokens),
            );
        let output_tokens = usage
            .audio_output_tokens
            .saturating_add(usage.text_output_tokens);
        per_1k(input_tokens, self.input_milli_cents_per_1k_tokens)
            .saturating_add(per_1k(output_tokens, self.output_milli_cents_per_1k_tokens))
    }

    pub fn estimate_usd(&self, usage: &BrainUsage) -> f64 {
        self.estimate_milli_cents(usage) as f64 / 100_000.0
    }
}

pub fn usage_event(
    voice_session_id: Option<Uuid>,
    provider: impl Into<String>,
    model: impl Into<String>,
    duration_seconds: u64,
    usage: BrainUsage,
    cost_model: &CostModel,
) -> VoiceUsageEvent {
    VoiceUsageEvent {
        id: Uuid::new_v4(),
        voice_session_id,
        provider: provider.into(),
        model: model.into(),
        duration_seconds,
        text_input_tokens: usage.text_input_tokens,
        text_output_tokens: usage.text_output_tokens,
        audio_input_tokens: usage.audio_input_tokens,
        audio_output_tokens: usage.audio_output_tokens,
        cost_estimate_usd: cost_model.estimate_usd(&usage),
        first_audio_latency_ms: None,
        answer_eval_latency_ms: None,
        source_retrieval_latency_ms: None,
        source_grounded_correction_count: usage.source_grounded_correction_count,
        created_at: Utc::now(),
    }
}

fn per_1k(tokens: u64, rate: u64) -> u64 {
    tokens.saturating_mul(rate).saturating_add(999) / 1_000
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cost_estimate_subtracts_cached_input_tokens() {
        let usage = BrainUsage {
            text_input_tokens: 2_000,
            cached_text_input_tokens: 1_000,
            text_output_tokens: 1_000,
            ..BrainUsage::default()
        };

        assert_eq!(CostModel::default().estimate_milli_cents(&usage), 100);
    }

    #[test]
    fn usage_event_matches_voice_usage_events_columns() {
        let session_id = Uuid::new_v4();
        let usage = BrainUsage {
            text_input_tokens: 25,
            text_output_tokens: 12,
            audio_input_tokens: 48,
            audio_output_tokens: 96,
            source_grounded_correction_count: 1,
            ..BrainUsage::default()
        };
        let expected_cost_estimate = CostModel::default().estimate_usd(&usage);
        let event = usage_event(
            Some(session_id),
            "synthetic",
            "synthetic-viva",
            42,
            usage,
            &CostModel::default(),
        );

        assert_eq!(event.voice_session_id, Some(session_id));
        assert_eq!(event.duration_seconds, 42);
        assert_eq!(event.text_input_tokens, 25);
        assert_eq!(event.text_output_tokens, 12);
        assert_eq!(event.audio_input_tokens, 48);
        assert_eq!(event.audio_output_tokens, 96);
        assert_eq!(event.cost_estimate_usd, expected_cost_estimate);
        assert_eq!(event.source_grounded_correction_count, 1);
    }
}
