//! `SERVICE-017`: admitted turn registration, response binding, the single event classifier, the context-refresh policy, and between-turn idle state.
//!
//! Moved verbatim out of `ws.rs` by the responsibility split. No route,
//! response, timer, capacity transition, authorization decision, store or
//! provider call, protocol frame, or cleanup order changed; only the file the
//! code lives in and the visibility the move forces.

use super::*;

/// `SERVICE-006`: how one provider event resolves outstanding turn work. There is
/// exactly one mapping and both the submitted-answer counter and the
/// active-provider-turn counter consume the same returned value, so the two can
/// never disagree about whether a turn ended.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum ProviderTurnResolution {
    One { response_id: Option<String> },
    All,
}

/// The single classification of a provider event.
///
/// `BrainEvent` is `#[non_exhaustive]` in another crate, so the final arm safely
/// ignores a future event until its contract owner classifies it; every current
/// variant is named explicitly above it and pinned by the lane's table test.
pub(super) fn classify_provider_turn_event(event: &BrainEvent) -> Option<ProviderTurnResolution> {
    match event {
        BrainEvent::TerminalSessionPhase { .. } => Some(ProviderTurnResolution::All),
        BrainEvent::AnswerEvaluated { response_id, .. }
        | BrainEvent::RecapReady { response_id, .. }
        | BrainEvent::ResponseCompleted { response_id }
        | BrainEvent::TurnDeferred { response_id, .. }
        | BrainEvent::ResponseCancelledFor { response_id } => Some(ProviderTurnResolution::One {
            response_id: Some(response_id.clone()),
        }),
        BrainEvent::ResponseCancelled => Some(ProviderTurnResolution::One { response_id: None }),
        BrainEvent::SessionPhase { .. }
        | BrainEvent::QuestionStarted { .. }
        | BrainEvent::TranscriptDelta { .. }
        | BrainEvent::SourceReference { .. }
        | BrainEvent::ConceptStatus { .. }
        | BrainEvent::ManuscriptIntent { .. }
        | BrainEvent::AudioDelta { .. }
        | BrainEvent::ResponseStarted { .. }
        | BrainEvent::ResponseAudio { .. }
        | BrainEvent::Transcript(_)
        | BrainEvent::ResponseToolProposal { .. }
        | BrainEvent::Usage(_)
        | BrainEvent::ProviderFallbackActivated { .. }
        | BrainEvent::Error(_)
        | BrainEvent::SpeechIntent(_)
        | BrainEvent::InputSpeechStarted
        | BrainEvent::InputSpeechStopped
        | BrainEvent::ResponseTranscriptDelta { .. }
        | BrainEvent::ResponseTextStarted { .. }
        | BrainEvent::TranscriptFinal { .. } => None,
        _ => None,
    }
}

/// `SERVICE-001`: return a socket with no outstanding work to the between-turn
/// sleeping-client deadline. Returns `false` — leaving the deadline exactly where
/// it was — while any submitted answer or provider turn is still outstanding, so
/// a mid-turn event can never postpone it.
pub(super) fn rearm_between_turn_idle(
    pending_submitted_answers: u32,
    active_provider_turns: u32,
    mut sleeper: Pin<&mut Sleep>,
    now: Instant,
    timeout: Duration,
) -> bool {
    if pending_submitted_answers != 0 || active_provider_turns != 0 {
        return false;
    }
    sleeper.as_mut().reset(now + timeout);
    true
}

/// `VOICE-TURN-001` / `VOICE-TURN-002`: the socket's wire-turn accounting.
///
/// Why a turn binding was refused. Every variant is a fail-closed refusal; none
/// of them is an invitation to invent a replacement identifier.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub(super) enum TurnBindingError {
    #[error("turn id is already registered on this socket")]
    DuplicateTurn,
    #[error("response id is already bound to a turn")]
    DuplicateResponse,
    #[error("no registered turn is waiting for a question")]
    MissingTurn,
    #[error("response id has no turn binding")]
    MissingResponse,
    #[error("more than one open submission could own this resolution")]
    AmbiguousTurn,
}

/// `SERVICE-014`: the socket's own record of which wire turn each provider
/// response belongs to.
///
/// The active v5 turn binding is tracked separately from provider response
/// identity: a turn is registered when its input is admitted (or minted by the
/// server before a proactive provider question), bound to a response when that
/// response's `question_started` arrives, and released only after that response's
/// single resolution has been forwarded. A released turn id is spent, never
/// recycled.
#[derive(Debug, Default)]
pub(super) struct TurnBindingTracker {
    pub(super) pending_turn_ids: VecDeque<String>,
    pub(super) response_to_turn: HashMap<String, String>,
    pub(super) spent_turn_ids: HashSet<String>,
    pub(super) minted: u32,
}

impl TurnBindingTracker {
    pub(super) fn register_submission(&mut self, turn_id: String) -> Result<(), TurnBindingError> {
        if self.knows_turn(&turn_id) {
            return Err(TurnBindingError::DuplicateTurn);
        }
        self.pending_turn_ids.push_back(turn_id);
        Ok(())
    }

    /// Whether this socket has ever used `turn_id`: pending, bound, or spent.
    pub(super) fn knows_turn(&self, turn_id: &str) -> bool {
        self.pending_turn_ids.iter().any(|known| known == turn_id)
            || self.response_to_turn.values().any(|known| known == turn_id)
            || self.spent_turn_ids.contains(turn_id)
    }

    /// A provider that asks proactively names no client turn, so the server mints
    /// the canonical id itself *before* the question can be bound. This is the
    /// only place an identifier is created; a deferral never mints one.
    pub(super) fn register_server_turn(&mut self) -> Result<String, TurnBindingError> {
        self.minted = self.minted.saturating_add(1);
        let turn_id = format!("turn-{}", self.minted);
        self.register_submission(turn_id.clone())?;
        Ok(turn_id)
    }

    pub(super) fn bind_question(&mut self, response_id: &str) -> Result<&str, TurnBindingError> {
        if self.response_to_turn.contains_key(response_id) {
            return Err(TurnBindingError::DuplicateResponse);
        }
        let turn_id = self
            .pending_turn_ids
            .pop_front()
            .ok_or(TurnBindingError::MissingTurn)?;
        self.response_to_turn
            .insert(response_id.to_owned(), turn_id);
        self.response_to_turn
            .get(response_id)
            .map(String::as_str)
            .ok_or(TurnBindingError::MissingTurn)
    }

    /// Bind a resolution for a response identity this socket never announced.
    ///
    /// A provider may resolve a turn it never opened a question for: the runner
    /// re-keys a first turn's response identity by the client generation of the
    /// answer it is resolving, without a second `question_started`. The socket
    /// still owes that resolution a wire turn, and it has exactly one piece of
    /// evidence to offer — an open submission that nothing else can claim. So
    /// the binding is allowed only when there is exactly one open submission.
    /// Two or more make the resolution ambiguous and it fails closed: guessing
    /// the oldest would spend a *different* submission's turn identity on it.
    /// Nothing is ever minted here, and a refusal consumes nothing.
    pub(super) fn bind_unannounced_deferral(
        &mut self,
        response_id: &str,
    ) -> Result<&str, TurnBindingError> {
        if self.response_to_turn.contains_key(response_id) {
            return Err(TurnBindingError::DuplicateResponse);
        }
        match self.pending_turn_ids.len() {
            0 => Err(TurnBindingError::MissingTurn),
            1 => self.bind_question(response_id),
            _ => Err(TurnBindingError::AmbiguousTurn),
        }
    }

    pub(super) fn turn_for_response(&self, response_id: &str) -> Result<&str, TurnBindingError> {
        self.response_to_turn
            .get(response_id)
            .map(String::as_str)
            .ok_or(TurnBindingError::MissingResponse)
    }

    /// Drop a response binding after its single resolution was forwarded.
    pub(super) fn release_response(&mut self, response_id: &str) {
        if let Some(turn_id) = self.response_to_turn.remove(response_id) {
            self.spent_turn_ids.insert(turn_id);
        }
    }
}

/// `SERVICE-014`: register a client-named turn once its bounded input is admitted.
///
/// A client that answers a turn the server already named is not opening a new
/// one, so an id this socket already knows is left exactly as it is. Only a turn
/// identity the socket has never seen becomes a pending client submission.
pub(super) fn register_submitted_turn(bindings: &mut TurnBindingTracker, turn_id: Option<&str>) {
    let Some(turn_id) = turn_id else {
        return;
    };
    if bindings.knows_turn(turn_id) {
        return;
    }
    let _ = bindings.register_submission(turn_id.to_owned());
}

/// Plan 05 publishes no `VoiceProtocolDiagnostic::invariant` constructor and
/// `protocol.rs` is its file, so the lane names the invariant code here rather
/// than editing an upstream contract.
pub(super) fn invariant_diagnostic(path: &'static str) -> VoiceProtocolDiagnostic {
    VoiceProtocolDiagnostic::new(VoiceProtocolDiagnosticCode::Invariant, path)
}

/// `VOICE-TURN-002`: look up the wire turn a persisted deferral belongs to and
/// hand both to Plan 05's constructor. Nothing about the frame is redeclared
/// here: the destructuring exists only to read `response_id` for the lookup, and
/// the constructor's own `Result` is returned unchanged.
pub(super) fn map_turn_deferred(
    event: &BrainEvent,
    bindings: &TurnBindingTracker,
) -> Result<ServerFrame, VoiceProtocolDiagnostic> {
    let BrainEvent::TurnDeferred { response_id, .. } = event else {
        return Err(invariant_diagnostic("$.event.type"));
    };
    let turn_id = bindings
        .turn_for_response(response_id)
        .map_err(|_| invariant_diagnostic("$.event.turn_id"))?;
    ServerFrame::turn_deferred(turn_id, event)
}

pub(super) struct ProviderTurnRuntime<'a> {
    pub(super) pending_submitted_answers: &'a mut u32,
    pub(super) active_provider_turns: &'a mut u32,
    pub(super) pending_provider_admissions: &'a mut Vec<VoiceLimitLease>,
    pub(super) resolved_submitted_answer_response_ids: &'a mut HashSet<String>,
    pub(super) completed_provider_turn_response_ids: &'a mut HashSet<String>,
    pub(super) superseded_provider_turn_response_ids: &'a mut HashSet<String>,
    pub(super) turn_cap_deadline: &'a mut Option<Instant>,
}

pub(super) fn apply_provider_turn_accounting(
    resolution: Option<ProviderTurnResolution>,
    runtime: &mut ProviderTurnRuntime<'_>,
) {
    let Some(resolution) = resolution else {
        return;
    };
    match resolution {
        ProviderTurnResolution::One { response_id } => {
            let count_resolution = match &response_id {
                Some(response_id) => runtime
                    .resolved_submitted_answer_response_ids
                    .insert(response_id.clone()),
                None => true,
            };
            if count_resolution {
                *runtime.pending_submitted_answers =
                    runtime.pending_submitted_answers.saturating_sub(1);
            }
            if *runtime.pending_submitted_answers == 0 {
                *runtime.turn_cap_deadline = None;
            }
            let count_completion = match response_id {
                Some(response_id) => {
                    let superseded_by_active_turn = *runtime.active_provider_turns > 1;
                    let count_completion = runtime
                        .completed_provider_turn_response_ids
                        .insert(response_id.clone());
                    if superseded_by_active_turn {
                        runtime
                            .superseded_provider_turn_response_ids
                            .insert(response_id);
                    }
                    count_completion
                }
                None => true,
            };
            if count_completion {
                *runtime.active_provider_turns = runtime.active_provider_turns.saturating_sub(1);
                let _ = runtime.pending_provider_admissions.pop();
            }
        }
        ProviderTurnResolution::All => {
            *runtime.pending_submitted_answers = 0;
            runtime.resolved_submitted_answer_response_ids.clear();
            *runtime.turn_cap_deadline = None;
            *runtime.active_provider_turns = 0;
            runtime.completed_provider_turn_response_ids.clear();
            runtime.superseded_provider_turn_response_ids.clear();
            runtime.pending_provider_admissions.clear();
        }
    }
}

pub(super) fn mark_completed_provider_turns_superseded(
    completed_provider_turn_response_ids: &HashSet<String>,
    superseded_provider_turn_response_ids: &mut HashSet<String>,
) {
    superseded_provider_turn_response_ids
        .extend(completed_provider_turn_response_ids.iter().cloned());
}

pub(super) fn should_suppress_superseded_recap(
    event: &agent_domain::BrainEvent,
    superseded_provider_turn_response_ids: &HashSet<String>,
) -> bool {
    matches!(
        event,
        agent_domain::BrainEvent::RecapReady { response_id, .. }
            if superseded_provider_turn_response_ids.contains(response_id)
    )
}

#[derive(Default)]
pub(super) struct CancelledResponseTracker {
    pub(super) active_response_id: Option<String>,
    pub(super) last_durable_response_id: Option<String>,
    pub(super) response_ids: HashSet<String>,
}

impl CancelledResponseTracker {
    pub(super) fn partial_recap_response_id(&self) -> Option<String> {
        self.active_response_id
            .clone()
            .or_else(|| self.last_durable_response_id.clone())
    }
}

pub(super) fn should_suppress_cancelled_response(
    cancelled_responses: &mut CancelledResponseTracker,
    event: &agent_domain::BrainEvent,
) -> bool {
    match event {
        agent_domain::BrainEvent::QuestionStarted { response_id, .. } => {
            cancelled_responses.active_response_id = Some(response_id.clone());
            cancelled_responses.last_durable_response_id = None;
            false
        }
        agent_domain::BrainEvent::ResponseCancelledFor { response_id } => {
            cancelled_responses.response_ids.insert(response_id.clone());
            if cancelled_responses
                .active_response_id
                .as_deref()
                .is_some_and(|active| active == response_id)
            {
                cancelled_responses.active_response_id = None;
            }
            if cancelled_responses
                .last_durable_response_id
                .as_deref()
                .is_some_and(|durable| durable == response_id)
            {
                cancelled_responses.last_durable_response_id = None;
            }
            false
        }
        agent_domain::BrainEvent::ResponseCancelled => {
            if let Some(response_id) = cancelled_responses.active_response_id.take() {
                cancelled_responses.response_ids.insert(response_id);
            }
            cancelled_responses.last_durable_response_id = None;
            false
        }
        agent_domain::BrainEvent::ResponseCompleted { response_id } => {
            if cancelled_responses.response_ids.contains(response_id) {
                return true;
            }
            cancelled_responses.last_durable_response_id = Some(response_id.clone());
            false
        }
        agent_domain::BrainEvent::RecapReady { response_id, .. } => {
            if cancelled_responses.response_ids.contains(response_id) {
                return true;
            }
            if cancelled_responses
                .active_response_id
                .as_deref()
                .is_some_and(|active| active == response_id)
            {
                cancelled_responses.active_response_id = None;
            }
            if cancelled_responses
                .last_durable_response_id
                .as_deref()
                .is_some_and(|durable| durable == response_id)
            {
                cancelled_responses.last_durable_response_id = None;
            }
            false
        }
        agent_domain::BrainEvent::ProviderFallbackActivated { .. } => false,
        _ => event
            .response_id()
            .is_some_and(|response_id| cancelled_responses.response_ids.contains(response_id)),
    }
}

#[cfg(test)]
pub(super) async fn handle_client_message(
    message: Message,
    input: &mpsc::Sender<BrainInput>,
    session_binding: &AuthorizedClientSession,
    audio_assembly: &mut AudioTurnAssembly,
) -> Result<ClientAction, ClientFrameError> {
    match client_input_action(message, session_binding, audio_assembly)? {
        ClientInputAction::Send {
            brain_input,
            action,
            ..
        } => input
            .send(brain_input)
            .await
            .map(|_| action)
            .map_err(|_| ClientFrameError::disconnected()),
        ClientInputAction::SendAudioTurn { brain_input, .. } => input
            .send(brain_input)
            .await
            .map(|_| ClientAction::Audio)
            .map_err(|_| ClientFrameError::disconnected()),
        ClientInputAction::TrySend {
            brain_input,
            action,
        } => {
            let _ = input.try_send(brain_input);
            Ok(action)
        }
        // The session loop answers a recoverable denial with its own frame before
        // reaching this point; nothing is ever forwarded for it.
        ClientInputAction::Keepalive | ClientInputAction::RecoverableDenial(_) => {
            Ok(ClientAction::Keepalive)
        }
        ClientInputAction::AudioTurnBuffered => Ok(ClientAction::AudioChunk),
        ClientInputAction::AudioTurnDiscarded => Ok(ClientAction::AudioTurnCancel),
    }
}

pub(super) fn prepare_client_message_with_drain(
    message: Message,
    session_binding: &AuthorizedClientSession,
    limits: &VoiceLimitConfig,
    session_limits: &mut SessionLimitRuntime,
    audio_assembly: &mut AudioTurnAssembly,
) -> Result<ClientInputAction, ClientMessageError> {
    let action = client_input_action(message, session_binding, audio_assembly)
        .map_err(ClientMessageError::Frame)?;
    let brain_input = match &action {
        ClientInputAction::Send { brain_input, .. }
        | ClientInputAction::SendAudioTurn { brain_input, .. } => Some(brain_input),
        _ => None,
    };
    if let Some(brain_input) = brain_input {
        if let Some(bytes) = brain_input_audio_bytes(brain_input) {
            if !session_limits.record_audio_bytes(limits, bytes) {
                return Err(ClientMessageError::RateLimit);
            }
        }
    }
    Ok(action)
}

pub(super) fn brain_input_audio_bytes(brain_input: &BrainInput) -> Option<u64> {
    match brain_input {
        BrainInput::Audio(frame) => Some(frame.pcm16_bytes().len().try_into().unwrap_or(u64::MAX)),
        BrainInput::AudioWithMetadata { frame, .. } => {
            Some(frame.pcm16_bytes().len().try_into().unwrap_or(u64::MAX))
        }
        _ => None,
    }
}

pub(super) fn validated_client_generation_id(
    value: Option<String>,
) -> Result<Option<String>, ClientFrameError> {
    match value {
        Some(value) if value.trim().is_empty() => Err(ClientFrameError::invalid()),
        Some(value) => Ok(Some(value)),
        None => Ok(None),
    }
}

/// One connection-local bounded audio turn under assembly. Retained until an
/// explicit `audio_end`, a matching scoped `cancel`, or a protocol violation.
#[derive(Debug)]
pub(super) struct IncomingAudioTurn {
    pub(super) client_generation_id: String,
    pub(super) turn_id: String,
    pub(super) next_sequence: u32,
    pub(super) pcm16: Vec<u8>,
}

/// How the connection-local audio turn most recently ended.
///
/// Only the last one is kept, because only the last one can still be racing a
/// client cancel. A submitted turn is already with the provider; a discarded one
/// never reached it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum SettledAudioTurn {
    Submitted {
        client_generation_id: String,
        turn_id: String,
    },
    Discarded {
        client_generation_id: String,
        turn_id: String,
    },
}

impl SettledAudioTurn {
    pub(super) fn identity(&self) -> (&str, &str) {
        match self {
            Self::Submitted {
                client_generation_id,
                turn_id,
            }
            | Self::Discarded {
                client_generation_id,
                turn_id,
            } => (client_generation_id, turn_id),
        }
    }
}

/// One bounded browser audio turn under assembly at a time, plus how the previous
/// one ended. Connection-local; nothing here is shared between sockets.
#[derive(Debug, Default)]
pub(super) struct AudioTurnAssembly {
    pub(super) open: Option<IncomingAudioTurn>,
    pub(super) settled: Option<SettledAudioTurn>,
}

impl AudioTurnAssembly {
    pub(super) fn settle(&mut self, settled: SettledAudioTurn) {
        self.settled = Some(settled);
    }

    pub(super) fn settled_as(
        &self,
        client_generation_id: &str,
        turn_id: &str,
    ) -> Option<&SettledAudioTurn> {
        self.settled
            .as_ref()
            .filter(|settled| settled.identity() == (client_generation_id, turn_id))
    }
}

#[derive(Debug)]
pub(super) enum AudioAssemblyAction {
    Pending,
    Complete {
        client_generation_id: String,
        turn_id: String,
        final_sequence: u32,
        frame: AudioFrame,
    },
    Cancelled,
    /// A scoped cancel that names a turn this connection already submitted. The
    /// bytes are with the provider, so the client is asking to cancel the turn,
    /// not the assembly.
    CancelSubmittedTurn,
    /// A scoped cancel that names a turn this connection already discarded. There
    /// is nothing left to cancel and no provider work was ever created.
    AlreadyDiscarded,
}

/// The completed turn identity echoed back to the browser once its single
/// assembled `BrainInput` has been admitted.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct AcceptedAudioTurn {
    pub(super) client_generation_id: String,
    pub(super) turn_id: String,
    pub(super) final_sequence: u32,
}

pub(super) fn audio_identity_is_valid(client_generation_id: &str, turn_id: &str) -> bool {
    !client_generation_id.trim().is_empty() && !turn_id.trim().is_empty()
}

/// `SERVICE-007`: why the stateful turn assembler refused a frame. Plan 05's parser
/// owns every per-frame diagnostic; these are the aggregate outcomes only this
/// assembler can decide, and each maps to exactly one published diagnostic code and
/// JSON path. No variant carries a payload, an identifier, or a byte count.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum AudioAssemblyRejection {
    /// A generation or turn id that is empty, or that does not own the open turn.
    InvalidIdentity,
    /// A payload that is empty or not a whole number of PCM16 samples.
    InvalidPayload,
    /// One chunk above the per-frame ceiling.
    ChunkTooLarge,
    /// The aggregate turn bound, which no single frame can carry.
    TurnTooLarge,
    /// A chunk sequence that is not the next one this turn expects.
    Sequence,
    /// An `audio_end` whose `final_sequence` does not close the open turn.
    FinalSequence,
}

impl AudioAssemblyRejection {
    /// The one classification of a stateful assembler rejection. Both the published
    /// diagnostic and the wire error are derived from it, so the two can never drift.
    pub(super) fn code(self) -> VoiceProtocolDiagnosticCode {
        match self {
            Self::InvalidIdentity | Self::InvalidPayload => {
                VoiceProtocolDiagnosticCode::InvalidField
            }
            Self::ChunkTooLarge => VoiceProtocolDiagnosticCode::FrameTooLarge,
            Self::TurnTooLarge => VoiceProtocolDiagnosticCode::TurnTooLarge,
            Self::Sequence | Self::FinalSequence => VoiceProtocolDiagnosticCode::AudioSequence,
        }
    }

    pub(super) fn path(self) -> &'static str {
        match self {
            Self::InvalidIdentity => "$.turn_id",
            Self::InvalidPayload | Self::ChunkTooLarge | Self::TurnTooLarge => {
                "$.frame.pcm16_base64"
            }
            Self::Sequence => "$.sequence",
            Self::FinalSequence => "$.final_sequence",
        }
    }

    pub(super) fn diagnostic(self) -> VoiceProtocolDiagnostic {
        VoiceProtocolDiagnostic::new(self.code(), self.path())
    }
}

impl From<VoiceProtocolDiagnostic> for ClientFrameError {
    /// The closed wire vocabulary a stateful assembler diagnostic maps to. The
    /// diagnostic keeps the sanitized code and path; the wire error keeps the coarse
    /// client-visible classification.
    fn from(diagnostic: VoiceProtocolDiagnostic) -> Self {
        match diagnostic.code {
            VoiceProtocolDiagnosticCode::FrameTooLarge => Self::oversized_audio_chunk(),
            VoiceProtocolDiagnosticCode::TurnTooLarge => Self::oversized_audio_turn(),
            _ => Self::invalid_audio_frame(),
        }
    }
}

pub(super) fn accept_audio_chunk(
    assembly: &mut AudioTurnAssembly,
    client_generation_id: String,
    turn_id: String,
    sequence: u32,
    frame: AudioFrame,
) -> Result<AudioAssemblyAction, VoiceProtocolDiagnostic> {
    let reject = |assembly: &mut AudioTurnAssembly, rejection: AudioAssemblyRejection| {
        assembly.open = None;
        Err(rejection.diagnostic())
    };

    if !audio_identity_is_valid(&client_generation_id, &turn_id) {
        return reject(assembly, AudioAssemblyRejection::InvalidIdentity);
    }

    // Decode before mutation: a rejected payload never reaches the retained turn.
    let pcm16 = frame.pcm16_bytes();
    if pcm16.is_empty() {
        return reject(assembly, AudioAssemblyRejection::InvalidPayload);
    }
    if pcm16.len() > VIVA_AUDIO_MAX_CHUNK_BYTES {
        return reject(assembly, AudioAssemblyRejection::ChunkTooLarge);
    }
    if !pcm16.len().is_multiple_of(2) {
        return reject(assembly, AudioAssemblyRejection::InvalidPayload);
    }

    match assembly.open.as_mut() {
        None => {
            if sequence != 0 {
                return reject(assembly, AudioAssemblyRejection::Sequence);
            }
            assembly.open = Some(IncomingAudioTurn {
                client_generation_id,
                turn_id,
                next_sequence: 1,
                pcm16: pcm16.to_vec(),
            });
        }
        Some(turn) => {
            if turn.client_generation_id != client_generation_id || turn.turn_id != turn_id {
                return reject(assembly, AudioAssemblyRejection::InvalidIdentity);
            }
            if turn.next_sequence != sequence {
                return reject(assembly, AudioAssemblyRejection::Sequence);
            }
            let Some(total) = turn.pcm16.len().checked_add(pcm16.len()) else {
                return reject(assembly, AudioAssemblyRejection::TurnTooLarge);
            };
            if total > VIVA_AUDIO_MAX_TURN_BYTES {
                return reject(assembly, AudioAssemblyRejection::TurnTooLarge);
            }
            let Some(next_sequence) = turn.next_sequence.checked_add(1) else {
                return reject(assembly, AudioAssemblyRejection::Sequence);
            };
            turn.pcm16.extend_from_slice(pcm16);
            turn.next_sequence = next_sequence;
        }
    }
    Ok(AudioAssemblyAction::Pending)
}

pub(super) fn accept_audio_end(
    assembly: &mut AudioTurnAssembly,
    client_generation_id: &str,
    turn_id: &str,
    final_sequence: u32,
) -> Result<AudioAssemblyAction, VoiceProtocolDiagnostic> {
    let Some(turn) = assembly.open.take() else {
        return Err(AudioAssemblyRejection::FinalSequence.diagnostic());
    };
    if turn.client_generation_id != client_generation_id || turn.turn_id != turn_id {
        return Err(AudioAssemblyRejection::InvalidIdentity.diagnostic());
    }
    if turn.next_sequence != final_sequence.saturating_add(1) {
        return Err(AudioAssemblyRejection::FinalSequence.diagnostic());
    }
    assembly.settle(SettledAudioTurn::Submitted {
        client_generation_id: turn.client_generation_id.clone(),
        turn_id: turn.turn_id.clone(),
    });
    Ok(AudioAssemblyAction::Complete {
        client_generation_id: turn.client_generation_id,
        turn_id: turn.turn_id,
        final_sequence,
        frame: AudioFrame::from_pcm16_bytes(turn.pcm16),
    })
}

/// A scoped cancel.
///
/// Cancelling and submitting the same turn race by construction: the browser
/// decides to cancel while its own `audio_end` is already on the wire. The
/// server has no way to make that race disappear, so a cancel that names a turn
/// this connection has already settled is answered for what it is — a request to
/// cancel a turn that is now with the provider, or a repeat of a cancel that
/// already discarded one — and never as a malformed audio frame. Only a scoped
/// cancel naming a turn this connection never saw is still a protocol error.
pub(super) fn accept_audio_cancel(
    assembly: &mut AudioTurnAssembly,
    client_generation_id: &str,
    turn_id: &str,
) -> Result<AudioAssemblyAction, VoiceProtocolDiagnostic> {
    let Some(turn) = assembly.open.take() else {
        return match assembly.settled_as(client_generation_id, turn_id) {
            Some(SettledAudioTurn::Submitted { .. }) => {
                Ok(AudioAssemblyAction::CancelSubmittedTurn)
            }
            Some(SettledAudioTurn::Discarded { .. }) => Ok(AudioAssemblyAction::AlreadyDiscarded),
            None => Err(AudioAssemblyRejection::InvalidIdentity.diagnostic()),
        };
    };
    if turn.client_generation_id != client_generation_id || turn.turn_id != turn_id {
        return Err(AudioAssemblyRejection::InvalidIdentity.diagnostic());
    }
    assembly.settle(SettledAudioTurn::Discarded {
        client_generation_id: turn.client_generation_id,
        turn_id: turn.turn_id,
    });
    Ok(AudioAssemblyAction::Cancelled)
}

pub(super) fn client_input_action(
    message: Message,
    session_binding: &AuthorizedClientSession,
    audio_assembly: &mut AudioTurnAssembly,
) -> Result<ClientInputAction, ClientFrameError> {
    match message {
        Message::Text(text) => {
            if text.len() > VIVA_VOICE_MAX_TEXT_FRAME_BYTES {
                return Err(ClientFrameError::oversized_text());
            }
            let frame: ClientFrame =
                serde_json::from_str(&text).map_err(|_| ClientFrameError::invalid())?;
            if frame.version() != VIVA_VOICE_PROTOCOL_VERSION {
                return Err(ClientFrameError::invalid());
            }
            match frame {
                ClientFrame::SessionConfig {
                    client_generation_id,
                    session_token,
                    session,
                    ..
                } => {
                    let sanitized = sanitize_refresh_session_config(
                        session,
                        &client_generation_id,
                        &session_token,
                        session_binding,
                    )?;
                    Ok(ClientInputAction::Send {
                        brain_input: BrainInput::SessionContextRefresh(
                            serde_json::to_value(sanitized)
                                .map_err(|_| ClientFrameError::invalid())?,
                        ),
                        action: ClientAction::ConfigRefresh,
                        turn_id: None,
                    })
                }
                ClientFrame::AudioChunk {
                    client_generation_id,
                    turn_id,
                    sequence,
                    frame,
                    ..
                } => {
                    match accept_audio_chunk(
                        audio_assembly,
                        client_generation_id,
                        turn_id,
                        sequence,
                        frame,
                    )? {
                        AudioAssemblyAction::Pending => Ok(ClientInputAction::AudioTurnBuffered),
                        AudioAssemblyAction::Complete { .. }
                        | AudioAssemblyAction::Cancelled
                        | AudioAssemblyAction::CancelSubmittedTurn
                        | AudioAssemblyAction::AlreadyDiscarded => {
                            Err(ClientFrameError::invalid_audio_frame())
                        }
                    }
                }
                ClientFrame::AudioEnd {
                    client_generation_id,
                    turn_id,
                    final_sequence,
                    ..
                } => {
                    match accept_audio_end(
                        audio_assembly,
                        &client_generation_id,
                        &turn_id,
                        final_sequence,
                    )? {
                        AudioAssemblyAction::Complete {
                            client_generation_id,
                            turn_id,
                            final_sequence,
                            frame,
                        } => Ok(ClientInputAction::SendAudioTurn {
                            brain_input: BrainInput::AudioWithMetadata {
                                frame,
                                client_generation_id: Some(client_generation_id.clone()),
                            },
                            accepted: AcceptedAudioTurn {
                                client_generation_id,
                                turn_id,
                                final_sequence,
                            },
                        }),
                        AudioAssemblyAction::Pending
                        | AudioAssemblyAction::Cancelled
                        | AudioAssemblyAction::CancelSubmittedTurn
                        | AudioAssemblyAction::AlreadyDiscarded => {
                            Err(ClientFrameError::invalid_audio_frame())
                        }
                    }
                }
                ClientFrame::TurnIntent {
                    client_generation_id,
                    turn_id,
                    intent,
                    ..
                } => {
                    let client_generation_id =
                        validated_client_generation_id(Some(client_generation_id))?;
                    match intent {
                        ClientTurnIntent::AnswerText { text } => Ok(ClientInputAction::Send {
                            brain_input: match client_generation_id {
                                Some(client_generation_id) => BrainInput::TextWithMetadata {
                                    text,
                                    client_generation_id: Some(client_generation_id),
                                },
                                None => BrainInput::Text(text),
                            },
                            action: ClientAction::AnswerText,
                            turn_id: Some(turn_id),
                        }),
                        // A citation challenge is not an answer and must never be
                        // graded as one. No typed provider input carries a challenge
                        // today, and synthesizing prose to stand in for one is exactly
                        // the magic-string payload the v5 contract removed, so the
                        // intent is refused instead of silently downgraded.
                        ClientTurnIntent::CitationChallenge { .. } => {
                            Err(ClientFrameError::citation_challenge_unroutable())
                        }
                    }
                }
                // `D-03B QUIZ_ONLY`: the one engine has no client-selectable mode and
                // no client goal, so every attempted context change is refused. The
                // frame reaches neither the provider nor the store, and the refusal
                // is recoverable: the socket and its deadlines are unchanged.
                ClientFrame::SessionRefresh {
                    client_generation_id,
                    ..
                } => {
                    // `session_refresh` is the only in-socket frame that could smuggle
                    // a renewed credential or a second identity, so it is re-read
                    // through Plan 05's strict parser: token, user, study, session,
                    // source and active-concept members are refused there, before this
                    // service applies any policy.
                    parse_client_frame_json(&text).map_err(|_| ClientFrameError::invalid())?;
                    bind_context_refresh(
                        &client_generation_id,
                        session_binding,
                        SESSION_REFRESH_POLICY,
                    )
                }
                ClientFrame::Cancel {
                    client_generation_id,
                    turn_id,
                    ..
                } => match turn_id {
                    // A scoped cancel discards a matching in-progress assembly and
                    // never creates a provider turn. v5 makes the generation
                    // mandatory, so a turn a client cannot prove it owns is
                    // unrepresentable rather than rejected at runtime.
                    Some(turn_id) => {
                        match accept_audio_cancel(audio_assembly, &client_generation_id, &turn_id)?
                        {
                            AudioAssemblyAction::Cancelled => {
                                Ok(ClientInputAction::AudioTurnDiscarded)
                            }
                            // The turn is already with the provider, so the
                            // client is asking to cancel the turn, not the
                            // assembly. This is the ordinary provider-response
                            // cancellation, scoped to a turn it can prove it owns.
                            AudioAssemblyAction::CancelSubmittedTurn => {
                                Ok(ClientInputAction::Send {
                                    brain_input: BrainInput::CancelResponse,
                                    action: ClientAction::Cancel,
                                    turn_id: Some(turn_id),
                                })
                            }
                            // Nothing left to cancel and no provider work was ever
                            // created: a benign no-op, not a protocol violation.
                            AudioAssemblyAction::AlreadyDiscarded => {
                                Ok(ClientInputAction::AudioTurnDiscarded)
                            }
                            AudioAssemblyAction::Pending | AudioAssemblyAction::Complete { .. } => {
                                Err(ClientFrameError::invalid_audio_frame())
                            }
                        }
                    }
                    // Without a turn id this preserves provider-response cancellation.
                    None => Ok(ClientInputAction::Send {
                        brain_input: BrainInput::CancelResponse,
                        action: ClientAction::Cancel,
                        turn_id: None,
                    }),
                },
                ClientFrame::Stop { .. } => Ok(ClientInputAction::TrySend {
                    brain_input: BrainInput::Stop,
                    action: ClientAction::Stop,
                }),
            }
        }
        // Protocol v5 has no binary client surface. Accepting one here would admit
        // an audio turn that never passed the bounded assembler, so the frame is
        // refused without inspecting its bytes.
        Message::Binary(_) => Err(ClientFrameError::unsupported_binary_frame()),
        Message::Close(_) => Ok(ClientInputAction::TrySend {
            brain_input: BrainInput::Stop,
            action: ClientAction::Close,
        }),
        Message::Ping(_) | Message::Pong(_) => Ok(ClientInputAction::Keepalive),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ClientAction {
    Audio,
    AudioChunk,
    AudioTurnCancel,
    AnswerText,
    Cancel,
    Close,
    ConfigRefresh,
    Keepalive,
    Stop,
}

impl ClientAction {
    pub(super) fn arms_turn_cap(self) -> bool {
        matches!(self, Self::Audio | Self::AnswerText)
    }
}

#[derive(Debug)]
pub(super) enum ClientInputAction {
    Send {
        brain_input: BrainInput,
        action: ClientAction,
        /// The v5 turn identity this submission names, when it names one. It is
        /// registered with the socket's turn bindings only once the input is
        /// actually admitted.
        turn_id: Option<String>,
    },
    /// One complete bounded audio turn, admitted exactly once at explicit end.
    SendAudioTurn {
        brain_input: BrainInput,
        accepted: AcceptedAudioTurn,
    },
    TrySend {
        brain_input: BrainInput,
        action: ClientAction,
    },
    Keepalive,
    /// A valid chunk retained in the connection-local assembly; nothing forwarded.
    AudioTurnBuffered,
    /// A matching scoped cancel discarded the assembly; no provider turn exists.
    AudioTurnDiscarded,
    /// A parsed frame service policy refuses without ending the session. Nothing is
    /// forwarded and no deadline moves.
    RecoverableDenial(RecoverablePolicyDenial),
}

impl ClientInputAction {
    pub(super) fn action(&self) -> ClientAction {
        match self {
            Self::Send { action, .. } | Self::TrySend { action, .. } => *action,
            Self::SendAudioTurn { .. } => ClientAction::Audio,
            Self::Keepalive | Self::RecoverableDenial(_) => ClientAction::Keepalive,
            Self::AudioTurnBuffered => ClientAction::AudioChunk,
            Self::AudioTurnDiscarded => ClientAction::AudioTurnCancel,
        }
    }

    pub(super) fn accepted_audio_turn(&self) -> Option<AcceptedAudioTurn> {
        match self {
            Self::SendAudioTurn { accepted, .. } => Some(accepted.clone()),
            _ => None,
        }
    }

    /// `SERVICE-014`: the v5 turn identity a submission names, for the socket's
    /// turn bindings. A keepalive, a buffered chunk, a discarded assembly, and a
    /// refused context change all name none.
    pub(super) fn submitted_turn_id(&self) -> Option<&str> {
        match self {
            Self::Send { turn_id, .. } => turn_id.as_deref(),
            Self::SendAudioTurn { accepted, .. } => Some(accepted.turn_id.as_str()),
            Self::TrySend { .. }
            | Self::Keepalive
            | Self::AudioTurnBuffered
            | Self::AudioTurnDiscarded
            | Self::RecoverableDenial(_) => None,
        }
    }

    pub(super) fn recoverable_denial(&self) -> Option<RecoverablePolicyDenial> {
        match self {
            Self::RecoverableDenial(denial) => Some(*denial),
            _ => None,
        }
    }
}

#[derive(Debug)]
pub(super) enum ClientMessageError {
    Frame(ClientFrameError),
    Drained,
    RateLimit,
    TurnCap,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct ClientFrameError {
    pub(super) auth_failure_code: Option<SessionAuthFailureCode>,
    /// `VOICE-ERROR-001`: the typed code the client frame carries. The wire
    /// vocabulary is closed by Plan 05, so every rejection selects exactly one
    /// member of it and `message` stays a human diagnostic nothing branches on.
    pub(super) code: VoiceServerErrorCode,
    pub(super) message: &'static str,
    pub(super) close_code: u16,
    pub(super) close_reason: &'static str,
    pub(super) terminal_reason: &'static str,
}

impl ClientFrameError {
    pub(super) fn invalid_first_frame() -> Self {
        Self {
            auth_failure_code: None,
            code: VoiceServerErrorCode::ClientFrameMalformed,
            message: "first client frame must be session_config",
            close_code: close_code::PROTOCOL,
            close_reason: "session config required",
            terminal_reason: "invalid_first_frame",
        }
    }

    pub(super) fn invalid() -> Self {
        Self {
            auth_failure_code: None,
            code: VoiceServerErrorCode::ClientFrameMalformed,
            message: "invalid client frame",
            close_code: close_code::PROTOCOL,
            close_reason: "invalid client frame",
            terminal_reason: "invalid_client_frame",
        }
    }

    pub(super) fn invalid_session_identity() -> Self {
        Self::session_auth_failed(SessionAuthFailureCode::IdentityMismatch)
    }

    pub(super) fn session_auth_failed(auth_failure_code: SessionAuthFailureCode) -> Self {
        Self {
            auth_failure_code: Some(auth_failure_code),
            code: match auth_failure_code {
                SessionAuthFailureCode::Expired => VoiceServerErrorCode::AuthExpired,
                SessionAuthFailureCode::Replayed => VoiceServerErrorCode::AuthReplayed,
                SessionAuthFailureCode::IdentityMismatch => {
                    VoiceServerErrorCode::AuthIdentityMismatch
                }
                SessionAuthFailureCode::Malformed
                | SessionAuthFailureCode::InvalidSignature
                | SessionAuthFailureCode::AccessDenied => VoiceServerErrorCode::AuthInvalid,
            },
            message: "session auth failed",
            close_code: close_code::POLICY,
            close_reason: "session auth failed",
            terminal_reason: match auth_failure_code {
                SessionAuthFailureCode::IdentityMismatch => "invalid_session_identity",
                SessionAuthFailureCode::AccessDenied => "study_set_access_denied",
                _ => "invalid_session_token",
            },
        }
    }

    pub(super) fn study_set_access_denied() -> Self {
        Self::session_auth_failed(SessionAuthFailureCode::AccessDenied)
    }

    /// A store that cannot answer at session bootstrap is reported with the same
    /// coarse authorization code as any other failed admission: the client learns
    /// only that authorization did not succeed, never which server component
    /// failed.
    pub(super) fn study_store_unavailable() -> Self {
        Self {
            auth_failure_code: None,
            code: VoiceServerErrorCode::AuthInvalid,
            message: "study store unavailable",
            close_code: close_code::POLICY,
            close_reason: "study store unavailable",
            terminal_reason: "study_store_unavailable",
        }
    }

    pub(super) fn nonce_store_unavailable() -> Self {
        Self {
            auth_failure_code: None,
            code: VoiceServerErrorCode::AuthInvalid,
            message: "session token nonce store unavailable",
            close_code: close_code::POLICY,
            close_reason: "session token nonce store unavailable",
            terminal_reason: concat!("session_", "token_nonce_store_unavailable"),
        }
    }

    /// A `citation_challenge` turn intent parses, but no typed provider input
    /// carries it. Refusing it keeps the challenge out of the answer-grading path
    /// entirely; it is never coerced into answer text.
    pub(super) fn citation_challenge_unroutable() -> Self {
        Self {
            auth_failure_code: None,
            code: VoiceServerErrorCode::ClientAuthorityForbidden,
            message: "citation challenge is not routable by this server",
            close_code: close_code::POLICY,
            close_reason: "citation challenge unavailable",
            terminal_reason: "citation_challenge_unroutable",
        }
    }

    /// `SERVICE-007`: a later frame naming a generation this socket did not bind is
    /// an identity failure, not a refresh. It never rebinds identity or a credential.
    pub(super) fn generation_mismatch() -> Self {
        Self::session_auth_failed(SessionAuthFailureCode::IdentityMismatch)
    }

    pub(super) fn oversized_text() -> Self {
        Self {
            auth_failure_code: None,
            code: VoiceServerErrorCode::ClientFrameTooLarge,
            message: "text frame exceeds maximum size",
            close_code: close_code::SIZE,
            close_reason: "text frame too large",
            terminal_reason: "oversized_text_frame",
        }
    }

    pub(super) fn invalid_audio_frame() -> Self {
        Self {
            auth_failure_code: None,
            code: VoiceServerErrorCode::ClientFrameMalformed,
            message: "invalid audio frame",
            close_code: close_code::PROTOCOL,
            close_reason: "invalid audio frame",
            terminal_reason: "invalid_audio_frame",
        }
    }

    pub(super) fn oversized_audio_chunk() -> Self {
        Self {
            auth_failure_code: None,
            code: VoiceServerErrorCode::ClientFrameTooLarge,
            message: "audio chunk exceeds maximum size",
            close_code: close_code::SIZE,
            close_reason: "audio chunk too large",
            terminal_reason: "oversized_audio_chunk",
        }
    }

    pub(super) fn oversized_audio_turn() -> Self {
        Self {
            auth_failure_code: None,
            code: VoiceServerErrorCode::ClientTurnTooLarge,
            message: "audio turn exceeds maximum size",
            close_code: close_code::SIZE,
            close_reason: "audio turn too large",
            terminal_reason: "oversized_audio_turn",
        }
    }

    /// Protocol v5 carries audio as bounded `audio_chunk`/`audio_end` JSON frames.
    /// A raw WebSocket binary frame is v4 legacy input that would bypass the turn
    /// assembler's generation, sequence, and aggregate-byte bounds entirely, so it
    /// is refused outright rather than size-checked.
    pub(super) fn unsupported_binary_frame() -> Self {
        Self {
            auth_failure_code: None,
            code: VoiceServerErrorCode::ClientFrameMalformed,
            message: "binary client frames are not accepted",
            close_code: close_code::UNSUPPORTED,
            close_reason: "binary client frames unsupported",
            terminal_reason: "unsupported_binary_frame",
        }
    }

    pub(super) fn disconnected() -> Self {
        Self {
            auth_failure_code: None,
            code: VoiceServerErrorCode::InternalSerialization,
            message: "agent input channel closed",
            close_code: close_code::ABNORMAL,
            close_reason: "agent input closed",
            terminal_reason: "agent_input_closed",
        }
    }
}

pub(super) fn record_client_action(
    state: &AppState,
    voice_session_id: Option<String>,
    action: ClientAction,
) {
    let (kind, detail) = match action {
        ClientAction::Audio => (
            VoiceEvidenceEventKind::AnswerReceived,
            "audio frame received",
        ),
        ClientAction::AnswerText => (
            VoiceEvidenceEventKind::AnswerReceived,
            "text answer received",
        ),
        ClientAction::Cancel => (VoiceEvidenceEventKind::CancelReceived, "cancel received"),
        ClientAction::Close => (VoiceEvidenceEventKind::StopReceived, "close received"),
        ClientAction::ConfigRefresh => (
            VoiceEvidenceEventKind::ConfigAccepted,
            "config refresh received",
        ),
        // Bounded chunks are connection-local until an explicit end; they are not
        // an answer and never enter the evidence pack on their own.
        ClientAction::AudioChunk | ClientAction::Keepalive => return,
        ClientAction::AudioTurnCancel => (
            VoiceEvidenceEventKind::CancelReceived,
            "audio turn cancel received",
        ),
        ClientAction::Stop => (VoiceEvidenceEventKind::StopReceived, "stop received"),
    };
    state
        .evidence
        .record(VoiceEvidenceEvent::new(kind, voice_session_id, detail));
}

pub(super) fn record_turn_cap_config(state: &AppState, voice_session_id: Option<String>) {
    let source = if state.turn_cap_override {
        "explicit_override"
    } else {
        "contract_default"
    };
    state.evidence.record(VoiceEvidenceEvent::new(
        VoiceEvidenceEventKind::ConfigAccepted,
        voice_session_id,
        format!(
            "turn_cap_ms={} source={} contract_max_ms={}",
            state.ws_timeouts.idle.as_millis(),
            source,
            bac_510_max_turn_duration().as_millis()
        ),
    ));
}
