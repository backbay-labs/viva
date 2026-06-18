"use client";

import {
  type AgentStudySetReadiness,
  type AnswerEvaluation,
  buildSessionRecap,
  createStudySetPreview,
  evaluateAnswer,
  generatedHomeCards,
  type SessionPhase,
  type SessionQuestion,
  type SessionRecap,
  type StudyMode,
  type StudySet,
  sampleQuestion,
  seedStudySets,
  type UploadedDocument,
} from "@viva/core";
import {
  ActionCard,
  ContextPill,
  Equalizer,
  FeedbackCard,
  Icon,
  MasteryChip,
  MasteryRing,
  MobileTabs,
  ModeChip,
  NavRail,
  ProgressBar,
  SourceChip,
  Spark,
  TimelineItem,
  TranscriptLine,
  VoiceOrb,
  Wordmark,
} from "@viva/ui-web";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVivaAgentSession } from "../../lib/use-viva-agent-session";
import { pasteStudySetToVivaApi, vivaApiBaseUrl } from "../../lib/viva-agent-client";
import {
  createBrowserVivaAudioCaptureSource,
  startVivaPcm16StreamingCapture,
  VIVA_AUDIO_SAMPLE_RATE_HZ,
  type VivaPcm16StreamingCaptureController,
} from "../../lib/viva-audio-capture";
import {
  createVivaAudioPlaybackSink,
  initialVivaAudioPlaybackState,
  unlockVivaAudioPlayback,
  type VivaAudioPlaybackSink,
} from "../../lib/viva-audio-playback";
import { sessionRestartAction } from "../../lib/viva-connected-actions";
import {
  connectedLifecycleStatusLabel,
  deriveVivaConnectedLifecycle,
} from "../../lib/viva-connected-lifecycle";
import { correctionQuote, recapStats, uploadPreviewSummary } from "../../lib/viva-display";

type View = "upload" | "home" | "session" | "recap" | "library";
type RuntimeMode = "connected-agent" | "local-demo";

function documentMetaLabel(document: UploadedDocument) {
  if (document.pages !== undefined) {
    return `${document.pages} pages`;
  }
  return document.processed ? "Pages unavailable" : "Pending extraction";
}

type SpeechRecognitionEventLike = {
  results: ArrayLike<{
    0: { transcript: string };
    isFinal: boolean;
  }>;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onstart?: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event?: { error?: string }) => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    AudioContext?: typeof AudioContext;
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitAudioContext?: typeof AudioContext;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

const modeLabels: Record<StudyMode, string> = {
  quiz: "Quiz me",
  teach: "Teach me",
  mock: "Mock viva",
  cram: "Cram",
};

export function shouldStopConnectedAudioForRecap({
  hasRecap,
  runtimeMode,
  view,
}: {
  hasRecap: boolean;
  runtimeMode: RuntimeMode;
  view: View;
}) {
  return runtimeMode === "connected-agent" && view === "session" && hasRecap;
}

export function VivaApp() {
  const [studySets, setStudySets] = useState<StudySet[]>(seedStudySets);
  const [currentStudySetId, setCurrentStudySetId] = useState(seedStudySets[0].id);
  const [view, setView] = useState<View>("upload");
  const [mode, setMode] = useState<StudyMode>("quiz");
  const [phase, setPhase] = useState<SessionPhase>("ready");
  const [answer, setAnswer] = useState("");
  const [evaluation, setEvaluation] = useState<AnswerEvaluation | null>(null);
  const [recap, setRecap] = useState<SessionRecap | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [accountCreated, setAccountCreated] = useState(false);
  const [expandedSetId, setExpandedSetId] = useState(seedStudySets[0].id);
  const [isDictating, setIsDictating] = useState(false);
  const [micState, setMicState] = useState<
    "idle" | "requesting" | "listening" | "denied" | "unsupported" | "insecure"
  >("idle");
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("connected-agent");
  const [agentStopRequested, setAgentStopRequested] = useState(false);
  const [agentProtocolNotice, setAgentProtocolNotice] = useState<string | null>(null);
  const [agentPlaybackState, setAgentPlaybackState] = useState(initialVivaAudioPlaybackState);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const connectedAudioCaptureRef = useRef<VivaPcm16StreamingCaptureController | null>(null);
  const connectedAudioCaptureGenerationRef = useRef(0);
  const agentPlaybackSinkRef = useRef<VivaAudioPlaybackSink | null>(null);
  const handledAgentAudioRef = useRef(0);
  const handledAgentCancellationsRef = useRef(0);

  const currentStudySet = useMemo(
    () => studySets.find((studySet) => studySet.id === currentStudySetId) ?? studySets[0],
    [studySets, currentStudySetId],
  );
  const agentSession = useVivaAgentSession({
    mode,
    sessionId: process.env.NEXT_PUBLIC_VIVA_VOICE_TRUSTED_SESSION_ID,
    studySet: currentStudySet,
    trustedStudySetId: process.env.NEXT_PUBLIC_VIVA_VOICE_TRUSTED_STUDY_SET_ID,
    userId: process.env.NEXT_PUBLIC_VIVA_VOICE_TRUSTED_USER_ID,
  });
  const agentUi = agentSession.derived;
  const connectedRuntime =
    runtimeMode === "connected-agent" && (view === "session" || view === "recap");
  const connectedLifecycle = deriveVivaConnectedLifecycle({
    connectedRuntime,
    state: agentSession.agentState,
    stopRequested: agentStopRequested,
  });
  const displayPhase = connectedRuntime ? agentUi.phase : phase;
  const displayQuestion = connectedRuntime ? agentUi.question : sampleQuestion;
  const displayEvaluation = connectedRuntime ? (agentUi.evaluation ?? null) : evaluation;
  const displayRecap = connectedRuntime ? (agentUi.recap ?? null) : recap;
  const recapForDisplay = connectedRuntime
    ? (agentUi.recap ?? null)
    : (displayRecap ?? buildSessionRecap(evaluation ?? evaluateAnswer(answer)));
  const canStartConnectedAgent = agentSession.readiness.canConnect;
  const scrollKey = `${view}:${phase}`;
  const getAgentPlaybackSink = useCallback(() => {
    if (agentPlaybackSinkRef.current) return agentPlaybackSinkRef.current;
    const sink = createVivaAudioPlaybackSink({
      contextFactory: () => {
        const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
        if (!AudioContextCtor) {
          throw new Error("Browser audio playback is unavailable");
        }
        return new AudioContextCtor({ sampleRate: VIVA_AUDIO_SAMPLE_RATE_HZ });
      },
      onStateChange: setAgentPlaybackState,
      outputSampleRateHz: VIVA_AUDIO_SAMPLE_RATE_HZ,
    });
    agentPlaybackSinkRef.current = sink;
    return sink;
  }, []);

  useEffect(() => {
    if (runtimeMode !== "connected-agent" || !agentStopRequested) return;
    if (agentUi.recap) {
      setAgentProtocolNotice(null);
      setView("recap");
      return;
    }
    if (connectedLifecycle === "ended_without_recap") {
      setAgentProtocolNotice(
        "Agent ended before sending a recap. No generated recap was accepted.",
      );
    }
  }, [agentStopRequested, agentUi.recap, connectedLifecycle, runtimeMode]);

  useEffect(() => {
    if (runtimeMode !== "connected-agent") {
      handledAgentAudioRef.current = agentSession.agentState.audio.length;
      handledAgentCancellationsRef.current = agentSession.agentState.cancelledResponseIds.length;
      return;
    }

    const nextAudio = agentSession.agentState.audio.slice(handledAgentAudioRef.current);
    const nextCancellations = agentSession.agentState.cancelledResponseIds.slice(
      handledAgentCancellationsRef.current,
    );
    if (nextAudio.length === 0 && nextCancellations.length === 0) return;

    const sink = getAgentPlaybackSink();
    for (const responseId of nextCancellations) sink.cancel(responseId);
    for (const output of nextAudio) sink.enqueue(output);
    handledAgentAudioRef.current = agentSession.agentState.audio.length;
    handledAgentCancellationsRef.current = agentSession.agentState.cancelledResponseIds.length;
  }, [
    agentSession.agentState.audio,
    agentSession.agentState.cancelledResponseIds,
    getAgentPlaybackSink,
    runtimeMode,
  ]);

  const stopConnectedAudioCapture = useCallback(() => {
    connectedAudioCaptureGenerationRef.current += 1;
    const capture = connectedAudioCaptureRef.current;
    connectedAudioCaptureRef.current = null;
    capture?.stop();
  }, []);

  useEffect(() => {
    if (
      !shouldStopConnectedAudioForRecap({
        hasRecap: Boolean(agentUi.recap),
        runtimeMode,
        view,
      })
    ) {
      return;
    }
    stopConnectedAudioCapture();
    setIsDictating(false);
    setMicState("idle");
    setAgentProtocolNotice(null);
    setPhase("recap");
    setView("recap");
  }, [agentUi.recap, runtimeMode, stopConnectedAudioCapture, view]);

  useEffect(() => {
    if (runtimeMode === "connected-agent" && view === "session") return;
    stopConnectedAudioCapture();
    setIsDictating(false);
    setMicState("idle");
  }, [runtimeMode, stopConnectedAudioCapture, view]);

  useEffect(() => {
    if (scrollKey.length > 0) {
      window.scrollTo(0, 0);
    }
  }, [scrollKey]);

  useEffect(
    () => () => {
      connectedAudioCaptureGenerationRef.current += 1;
      const capture = connectedAudioCaptureRef.current;
      connectedAudioCaptureRef.current = null;
      capture?.cancel();
      void agentPlaybackSinkRef.current?.close();
      agentPlaybackSinkRef.current = null;
    },
    [],
  );

  function unlockAgentAudioPlayback() {
    void getAgentPlaybackSink()
      .unlock()
      .catch(() => {
        setAgentPlaybackState((state) => unlockVivaAudioPlayback(state));
      });
  }

  function navigate(nextView: View) {
    setView(nextView);
    if (nextView === "session" && phase === "recap") {
      setPhase("ready");
    }
  }

  async function createStudySet(input: {
    courseName: string;
    examDate: string;
    pastedText: string;
    fileNames: string[];
  }) {
    setProcessing(true);
    setUploadNotice(null);
    setUploadProgress(34);
    const progressTimer = window.setTimeout(() => setUploadProgress(72), 260);
    const pastedText = input.pastedText.trim();
    const apiBaseUrl = pastedText ? vivaApiBaseUrl() : undefined;

    if (pastedText && apiBaseUrl) {
      try {
        setUploadNotice("Server paste ingestion processing.");
        const nextStudySet = await pasteStudySetToVivaApi(
          {
            course: input.courseName.trim() || null,
            examDate: input.examDate || undefined,
            pastedText,
            title: input.courseName.trim() || "New Study Set",
            userId:
              process.env.NEXT_PUBLIC_VIVA_USER_ID ??
              process.env.NEXT_PUBLIC_VIVA_VOICE_TRUSTED_USER_ID ??
              "user-1",
          },
          { apiBaseUrl },
        );
        window.clearTimeout(progressTimer);
        setStudySets((sets) => [nextStudySet, ...sets.filter((set) => set.id !== nextStudySet.id)]);
        setCurrentStudySetId(nextStudySet.id);
        setUploadNotice(`Server paste ingestion ${nextStudySet.ingestionStatus ?? "ready"}.`);
        setUploadProgress(100);
        setProcessing(false);
        return;
      } catch {
        setUploadNotice("Server paste ingestion failed. Local pending preview generated.");
      }
    } else if (pastedText) {
      setUploadNotice("Viva API URL unavailable. Local pending preview generated.");
    }

    window.setTimeout(() => {
      window.clearTimeout(progressTimer);
      const nextStudySet = createStudySetPreview(input);
      setStudySets((sets) => [nextStudySet, ...sets.filter((set) => set.id !== nextStudySet.id)]);
      setCurrentStudySetId(nextStudySet.id);
      setUploadProgress(100);
      setProcessing(false);
    }, 620);
  }

  function startSession(nextRuntimeMode: RuntimeMode = "connected-agent") {
    if (nextRuntimeMode === "connected-agent" && !canStartConnectedAgent) {
      setRuntimeMode("local-demo");
      setAgentStopRequested(false);
      setAgentProtocolNotice(agentSession.readiness.message);
      setAnswer("");
      setEvaluation(null);
      setRecap(null);
      setPhase("ready");
      setView("session");
      return;
    }
    setRuntimeMode(nextRuntimeMode);
    setAgentStopRequested(false);
    setAgentProtocolNotice(null);
    setAnswer("");
    setEvaluation(null);
    setRecap(null);
    setPhase("listening");
    setView("session");
    if (nextRuntimeMode === "connected-agent") {
      unlockAgentAudioPlayback();
    }
    if (
      nextRuntimeMode === "connected-agent" &&
      (agentSession.status === "idle" ||
        agentSession.status === "closed" ||
        agentSession.status === "error")
    ) {
      agentSession.reset();
      agentSession.connect();
    }
  }

  function submitAnswer(nextAnswer = answer) {
    setAnswer(nextAnswer);
    if (connectedRuntime) {
      unlockAgentAudioPlayback();
      if (!nextAnswer.trim()) {
        setAgentProtocolNotice("Enter a final typed or dictated answer before sending it.");
        return;
      }
      setAgentProtocolNotice(null);
      agentSession.sendText(nextAnswer);
      return;
    }
    const result = evaluateAnswer(nextAnswer);
    setEvaluation(result);
    setPhase("thinking");
    window.setTimeout(() => {
      setPhase("feedback");
      speak(result.conciseFeedback);
    }, 520);
  }

  function showCorrection() {
    setPhase("correction");
  }

  function retryAnswer() {
    const action = sessionRestartAction({
      connectedMode: connectedRuntime,
      canStartConnectedAgent,
    });
    setAnswer("");
    setEvaluation(null);
    setAgentProtocolNotice(null);
    setPhase("listening");
    if (action === "connected_reconnect") {
      setAgentStopRequested(false);
      setPhase("ready");
      setView("session");
      agentSession.reset();
      agentSession.connect();
    } else if (action === "connected_unavailable") {
      setRuntimeMode("local-demo");
      setAgentProtocolNotice(agentSession.readiness.message);
    }
  }

  function finishSession() {
    if (connectedRuntime) {
      setAgentStopRequested(true);
      stopConnectedAudioCapture();
      agentSession.stop();
      if (agentUi.recap) {
        setPhase("recap");
        setView("recap");
      }
      return;
    }
    const result = evaluation ?? evaluateAnswer(answer || "I think it produces 36 ATP.");
    setEvaluation(result);
    setRecap(buildSessionRecap(result));
    setPhase("recap");
    setView("recap");
  }

  function startAnotherDrill() {
    const action = sessionRestartAction({
      connectedMode: runtimeMode === "connected-agent",
      canStartConnectedAgent,
    });
    setAgentStopRequested(false);
    setAnswer("");
    setEvaluation(null);
    setRecap(null);
    setPhase("ready");
    setView("session");
    if (action === "local_listening") return;
    if (action === "connected_unavailable") {
      setRuntimeMode("local-demo");
      setAgentProtocolNotice(agentSession.readiness.message);
      return;
    }
    setAgentProtocolNotice(null);
    agentSession.reset();
    agentSession.connect();
  }

  function startDictation() {
    if (connectedRuntime) {
      startConnectedAudioCapture();
      return;
    }
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (window.isSecureContext === false && window.location.hostname !== "localhost") {
      setMicState("insecure");
      setAgentProtocolNotice("Browser dictation needs HTTPS or localhost.");
      setIsDictating(false);
      return;
    }
    if (!Recognition) {
      setMicState("unsupported");
      setAgentProtocolNotice("Browser dictation is unsupported. Use the text answer box instead.");
      setIsDictating(false);
      return;
    }

    setMicState("requesting");
    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0].transcript)
        .join(" ")
        .trim();
      setAnswer(transcript);
    };
    recognition.onstart = () => {
      setMicState("listening");
    };
    recognition.onend = () => {
      setIsDictating(false);
      setMicState((state) => (state === "denied" ? state : "idle"));
    };
    recognition.onerror = (event) => {
      setIsDictating(false);
      const error = event?.error ?? "unavailable";
      if (error === "not-allowed" || error === "service-not-allowed") {
        setMicState("denied");
        setAgentProtocolNotice("Browser dictation was denied. Use the text answer box instead.");
      } else if (error === "audio-capture") {
        setMicState("unsupported");
        setAgentProtocolNotice("No browser microphone was available. Use the text answer box.");
      } else {
        setMicState("idle");
        setAgentProtocolNotice("Browser dictation stopped. Use the text answer box instead.");
      }
    };
    recognitionRef.current = recognition;
    setIsDictating(true);
    setPhase("listening");
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setIsDictating(false);
      setMicState("unsupported");
      setAgentProtocolNotice("Browser dictation could not start. Use the text answer box.");
    }
  }

  async function startConnectedAudioCapture() {
    if (window.isSecureContext === false && window.location.hostname !== "localhost") {
      setMicState("insecure");
      setAgentProtocolNotice("Browser audio needs HTTPS or localhost.");
      setIsDictating(false);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicState("unsupported");
      setAgentProtocolNotice("Browser microphone capture is unavailable. Use the text answer box.");
      setIsDictating(false);
      return;
    }
    const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextCtor) {
      setMicState("unsupported");
      setAgentProtocolNotice("Browser audio capture is unavailable. Use the text answer box.");
      setIsDictating(false);
      return;
    }

    unlockAgentAudioPlayback();
    stopConnectedAudioCapture();
    const captureGeneration = connectedAudioCaptureGenerationRef.current;
    setMicState("requesting");
    setIsDictating(true);
    setPhase("listening");
    setAgentProtocolNotice(null);

    try {
      const source = await createBrowserVivaAudioCaptureSource({
        AudioContextCtor,
        mediaDevices: navigator.mediaDevices,
        sampleRateHz: VIVA_AUDIO_SAMPLE_RATE_HZ,
      });
      if (
        captureGeneration !== connectedAudioCaptureGenerationRef.current ||
        shouldStopConnectedAudioForRecap({
          hasRecap: Boolean(agentUi.recap),
          runtimeMode,
          view,
        })
      ) {
        await source.stop();
        setIsDictating(false);
        setMicState("idle");
        return;
      }
      connectedAudioCaptureRef.current = startVivaPcm16StreamingCapture({
        onError: () => {
          stopConnectedAudioCapture();
          setIsDictating(false);
          setMicState("unsupported");
          setAgentProtocolNotice("Browser audio capture stopped. Use the text answer box.");
        },
        onFrame: (frame) => {
          agentSession.sendAudio(frame.pcm16Base64);
        },
        sampleRateHz: VIVA_AUDIO_SAMPLE_RATE_HZ,
        source,
      });
      setMicState("listening");
    } catch {
      stopConnectedAudioCapture();
      setIsDictating(false);
      setMicState("denied");
      setAgentProtocolNotice("Browser audio capture was denied. Use the text answer box.");
    }
  }

  function stopDictation() {
    if (connectedRuntime) {
      stopConnectedAudioCapture();
      setIsDictating(false);
      setMicState("idle");
      return;
    }
    recognitionRef.current?.stop();
    setIsDictating(false);
    setMicState("idle");
  }

  function deleteDocument(studySetId: string, documentId: string) {
    setStudySets((sets) =>
      sets.map((studySet) =>
        studySet.id === studySetId
          ? { ...studySet, docs: studySet.docs.filter((document) => document.id !== documentId) }
          : studySet,
      ),
    );
  }

  function archiveStudySet(studySetId: string) {
    const remaining = studySets.filter((studySet) => studySet.id !== studySetId);
    setStudySets(remaining);
    if (currentStudySetId === studySetId && remaining.length > 0) {
      setCurrentStudySetId(remaining[0].id);
    }
  }

  const activeTab =
    view === "library" ? "Library" : view === "session" || view === "recap" ? "Sessions" : "Today";

  if (view === "upload") {
    return (
      <UploadScreen
        accountCreated={accountCreated}
        onCreateAccount={() => setAccountCreated(true)}
        onCreateStudySet={createStudySet}
        onEnterHome={() => setView("home")}
        processing={processing}
        progress={uploadProgress}
        studySet={currentStudySet}
        uploadNotice={uploadNotice}
      />
    );
  }

  return (
    <main className="app-shell">
      <NavRail
        active={activeTab}
        footer={
          <div className="nav-rail__review-card">
            <p className="kicker">Next review</p>
            <strong>Tomorrow · 8 min</strong>
            <small>NADH, Krebs cycle</small>
          </div>
        }
        onNavigate={(nextView) => navigate(nextView)}
      />
      <section className="main-panel">
        {view === "home" ? (
          <HomeScreen
            agentReadiness={agentSession.readiness}
            canStartConnectedAgent={canStartConnectedAgent}
            mode={mode}
            onModeChange={setMode}
            onStartDemo={() => startSession("local-demo")}
            onStartSession={() => startSession("connected-agent")}
            onUpload={() => setView("upload")}
            studySet={currentStudySet}
          />
        ) : null}
        {view === "session" ? (
          <SessionScreen
            answer={answer}
            agentSpeaking={
              connectedRuntime && (agentPlaybackState.speaking || agentPlaybackState.responding)
            }
            canSubmitAnswer={
              !connectedRuntime ||
              (Boolean(agentUi.question) && agentUi.canSubmitAnswer && answer.trim().length > 0)
            }
            connectionStatus={
              connectedRuntime
                ? connectedLifecycleStatusLabel(connectedLifecycle)
                : agentSession.status
            }
            connectedRuntime={connectedRuntime}
            errors={agentUi.errors}
            evaluation={displayEvaluation}
            isDictating={isDictating}
            micState={micState}
            mode={mode}
            onAnswerChange={setAnswer}
            onDictate={startDictation}
            onEnd={finishSession}
            onModeChange={setMode}
            onRetryAnswer={retryAnswer}
            onShowCorrection={showCorrection}
            onStart={startSession}
            onStopDictation={stopDictation}
            onSubmitAnswer={submitAnswer}
            phase={displayPhase}
            protocolNotice={agentProtocolNotice}
            question={displayQuestion}
            studySet={currentStudySet}
            transcript={connectedRuntime ? agentUi.transcript : answer}
          />
        ) : null}
        {view === "recap" && recapForDisplay ? (
          <RecapScreen
            connectedRuntime={connectedRuntime}
            onAnotherDrill={startAnotherDrill}
            onSchedule={() => setView("home")}
            recap={recapForDisplay}
          />
        ) : null}
        {view === "library" ? (
          <LibraryScreen
            expandedSetId={expandedSetId}
            onArchive={archiveStudySet}
            onDeleteDocument={deleteDocument}
            onExpand={setExpandedSetId}
            onNewStudySet={() => setView("upload")}
            onResume={(studySetId) => {
              setCurrentStudySetId(studySetId);
              setView("home");
            }}
            studySets={studySets}
          />
        ) : null}
        <MobileTabs active={activeTab} onNavigate={(nextView) => navigate(nextView)} />
      </section>
    </main>
  );
}

export function UploadScreen({
  accountCreated,
  onCreateAccount,
  onCreateStudySet,
  onEnterHome,
  processing,
  progress,
  studySet,
  uploadNotice,
}: {
  accountCreated: boolean;
  onCreateAccount: () => void;
  onCreateStudySet: (input: {
    courseName: string;
    examDate: string;
    pastedText: string;
    fileNames: string[];
  }) => void | Promise<void>;
  onEnterHome: () => void;
  processing: boolean;
  progress: number;
  studySet: StudySet;
  uploadNotice?: string | null;
}) {
  const [courseName, setCourseName] = useState("");
  const [examDate, setExamDate] = useState("");
  const [pastedText, setPastedText] = useState("");
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);

  const hasPreview = progress === 100 && !processing;
  const canProcess =
    courseName.trim().length > 0 &&
    (pastedText.trim().length > 0 || fileNames.length > 0) &&
    !fileError;
  const previewSummary = uploadPreviewSummary(studySet);

  return (
    <main className="upload-screen">
      <header className="upload-screen__header">
        <Wordmark size={28} />
        <span className="kicker">{accountCreated ? "Account ready" : "New study set"}</span>
      </header>
      <section className="upload-hero">
        <div className="upload-hero__intro">
          <VoiceOrb size={74} state="ready" />
          <h1 className="display">What are we studying?</h1>
          <p>
            Drop in your notes, slides, readings, or study guide. Pasted notes go to server-owned
            ingestion when the Viva API is configured; otherwise Viva keeps a local pending preview.
          </p>
          <div className="account-strip">
            <Spark color="var(--gold)" size={15} />
            <span>
              {accountCreated
                ? "Ananya's local beta account is ready."
                : "Create a local beta account to keep session memory."}
            </span>
            {!accountCreated ? (
              <button className="text-button" onClick={onCreateAccount} type="button">
                Create account
              </button>
            ) : null}
          </div>
        </div>
        <form
          className="upload-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canProcess) {
              setFileError(
                "Add a study set name and at least one supported note, slide, or paste.",
              );
              return;
            }
            onCreateStudySet({ courseName, examDate, pastedText, fileNames });
          }}
        >
          <label className="field">
            <span>Course / study set name</span>
            <input
              onChange={(event) => {
                setCourseName(event.target.value);
                if (!fileNames.length) setFileError(null);
              }}
              value={courseName}
            />
          </label>
          <label className="field">
            <span>Exam date</span>
            <input
              onChange={(event) => setExamDate(event.target.value)}
              type="date"
              value={examDate}
            />
          </label>
          <label className="dropzone">
            <input
              accept=".pdf,.txt,.md,.ppt,.pptx,application/pdf"
              multiple
              onChange={(event) => {
                setFileError(null);
                const files = Array.from(event.target.files ?? []);
                const unsupported = files.find(
                  (file) =>
                    !/\.(pdf|txt|md|ppt|pptx)$/i.test(file.name) && file.type !== "application/pdf",
                );
                const tooLarge = files.find((file) => file.size > 20 * 1024 * 1024);
                if (unsupported) {
                  setFileError(`${unsupported.name} is not a supported document type.`);
                  setFileNames([]);
                  return;
                }
                if (tooLarge) {
                  setFileError(`${tooLarge.name} is over the 20 MB local preview limit.`);
                  setFileNames([]);
                  return;
                }
                const names = files.map((file) => file.name);
                if (names.length > 0) {
                  setFileNames(names);
                }
              }}
              type="file"
            />
            <span className="dropzone__icon">
              <Icon color="var(--plum)" name="upload" size={26} />
            </span>
            <strong>Drop PDFs, slides, or notes</strong>
            <small>{fileNames.length ? fileNames.join(" · ") : "or paste text below"}</small>
            <span className="dropzone__formats">PDF · Slides · Notes · Transcript</span>
          </label>
          {fileError ? (
            <p className="session-nudge">
              <Icon color="var(--amber)" name="flag" size={15} />
              {fileError}
            </p>
          ) : null}
          <label className="field field--textarea">
            <span>Paste notes</span>
            <textarea
              onChange={(event) => {
                setPastedText(event.target.value);
                if (!fileNames.length) setFileError(null);
              }}
              value={pastedText}
            />
          </label>
          {progress > 0 ? (
            <ProgressBar
              label={
                processing
                  ? "Building study set..."
                  : studySet.ingestionStatus
                    ? `Ingestion ${studySet.ingestionStatus}`
                    : "Preview generated"
              }
              value={progress}
            />
          ) : null}
          {uploadNotice ? (
            <p className="session-nudge">
              <Icon color="var(--amber)" name="flag" size={15} />
              {uploadNotice}
            </p>
          ) : null}
          <button
            className="button button-primary"
            disabled={processing || !canProcess}
            type="submit"
          >
            <Icon color="var(--plum-soft)" name="spark4" size={17} />
            {processing ? "Building study set" : "Generate local preview"}
          </button>
        </form>
      </section>
      {hasPreview ? (
        <section className="generated-preview">
          <div>
            <p className="kicker">
              {studySet.serverOwned ? "Server study set" : "Local study preview"}
            </p>
            <h2 className="display">{studySet.title}</h2>
            <ContextPill
              items={[
                `${studySet.docs.length} documents`,
                studySet.examDateLabel,
                ingestionStatusLabel(studySet),
              ]}
              small
            />
          </div>
          <div className="recommended-session">
            <p className="kicker">{previewSummary.conceptLabel}</p>
            <strong>Recommended first session: {studySet.recommendedSession}</strong>
          </div>
          <div className="preview-topics">
            {studySet.concepts.slice(0, 8).map((concept) => (
              <MasteryChip key={concept.id} label={concept.label} tier={concept.status} />
            ))}
            <span>{previewSummary.overflowLabel}</span>
          </div>
          <div className="preview-docs">
            {studySet.docs.map((document) => (
              <span className="document-row" key={document.id}>
                <Icon color="var(--plum)" name="doc" size={16} />
                <strong>{document.name}</strong>
                <small>{documentMetaLabel(document)}</small>
              </span>
            ))}
          </div>
          <button className="button button-primary" onClick={onEnterHome} type="button">
            <Icon color="var(--plum-soft)" name="mic" size={18} />
            Start first recall drill
          </button>
        </section>
      ) : null}
    </main>
  );
}

function ingestionStatusLabel(studySet: StudySet): string {
  if (studySet.ingestionStatus === "ready") return "Ingestion ready";
  if (studySet.ingestionStatus === "processing") return "Ingestion processing";
  if (studySet.ingestionStatus === "failed") return "Ingestion failed";
  return "Ingestion pending";
}

export function HomeScreen({
  agentReadiness,
  canStartConnectedAgent,
  mode,
  onModeChange,
  onStartDemo,
  onStartSession,
  onUpload,
  studySet,
}: {
  agentReadiness: AgentStudySetReadiness;
  canStartConnectedAgent: boolean;
  mode: StudyMode;
  onModeChange: (mode: StudyMode) => void;
  onStartDemo: () => void;
  onStartSession: () => void;
  onUpload: () => void;
  studySet: StudySet;
}) {
  const cards = generatedHomeCards(studySet);

  return (
    <div className="home-screen">
      <header className="screen-topbar">
        <div>
          <p className="kicker">Monday · 15 June</p>
          <span>Good evening, Ananya</span>
        </div>
        <button className="button button-secondary" onClick={onUpload} type="button">
          <Icon color="var(--plum)" name="upload" size={15} />
          Upload
        </button>
      </header>
      <section className="home-hero">
        <ContextPill
          items={[studySet.title, `${studySet.docs.length} docs`, studySet.examDateLabel]}
        />
        <h1 className="display">Talk your way to mastery</h1>
        <div className="orb-stage">
          <VoiceOrb size={158} state="ready" />
          {studySet.concepts.slice(0, 4).map((concept, index) => (
            <span className={`orbit-chip orbit-chip--${index}`} key={concept.id}>
              <span />
              {concept.label}
            </span>
          ))}
        </div>
        <button
          className="button button-primary home-cta"
          disabled={!canStartConnectedAgent}
          onClick={onStartSession}
          type="button"
        >
          <Icon color="var(--plum-soft)" name="mic" size={18} />
          {canStartConnectedAgent ? "Start 10-minute recall drill" : "Agent unavailable"}
        </button>
        {!canStartConnectedAgent ? (
          <p className="session-nudge">
            <Icon color="var(--amber)" name="flag" size={15} />
            {agentReadiness.message}
          </p>
        ) : null}
        <button className="button button-secondary" onClick={onStartDemo} type="button">
          <Icon color="var(--plum)" name="quiz" size={16} />
          Run local demo drill
        </button>
        <div className="mode-row">
          {(["quiz", "teach", "mock", "cram"] as StudyMode[]).map((nextMode) => (
            <ModeChip
              active={mode === nextMode}
              key={nextMode}
              label={modeLabels[nextMode]}
              mode={nextMode}
              onClick={() => onModeChange(nextMode)}
            />
          ))}
        </div>
      </section>
      <section className="generated-card-grid">
        {cards.slice(0, 3).map((card) => (
          <ActionCard
            accent={card.accent}
            body={card.body}
            icon={
              card.kind === "weak concept"
                ? "target"
                : card.kind === "next best session"
                  ? "bars"
                  : "cal"
            }
            key={card.id}
            kicker={card.kind}
            title={card.title}
          />
        ))}
        <div className="mastery-card">
          <MasteryRing color="var(--sage)" pct={studySet.mastery.strong} size={74} />
          <div>
            <p className="kicker">Mastery</p>
            <strong className="serif">{studySet.mastery.strong}% strong</strong>
            <small>
              {studySet.mastery.shaky}% shaky · {studySet.mastery.review}% review
            </small>
          </div>
        </div>
      </section>
    </div>
  );
}

export function SessionScreen({
  answer,
  agentSpeaking = false,
  canSubmitAnswer,
  connectionStatus,
  connectedRuntime,
  errors,
  evaluation,
  isDictating,
  micState,
  mode,
  onAnswerChange,
  onDictate,
  onEnd,
  onModeChange,
  onRetryAnswer,
  onShowCorrection,
  onStart,
  onStopDictation,
  onSubmitAnswer,
  phase,
  protocolNotice,
  question,
  studySet,
  transcript,
}: {
  answer: string;
  agentSpeaking?: boolean;
  canSubmitAnswer: boolean;
  connectionStatus: string;
  connectedRuntime: boolean;
  errors: string[];
  evaluation: AnswerEvaluation | null;
  isDictating: boolean;
  micState: "idle" | "requesting" | "listening" | "denied" | "unsupported" | "insecure";
  mode: StudyMode;
  onAnswerChange: (answer: string) => void;
  onDictate: () => void;
  onEnd: () => void;
  onModeChange: (mode: StudyMode) => void;
  onRetryAnswer: () => void;
  onShowCorrection: () => void;
  onStart: () => void;
  onStopDictation: () => void;
  onSubmitAnswer: (answer?: string) => void;
  phase: SessionPhase;
  protocolNotice: string | null;
  question?: SessionQuestion;
  studySet: StudySet;
  transcript: string;
}) {
  const waitingForQuestion = connectedRuntime && !question;
  const waitingForEvaluation = connectedRuntime && phase === "feedback" && !evaluation;
  const waitingForCorrection = connectedRuntime && phase === "correction" && !evaluation;
  const rendersReadyPrompt = !waitingForQuestion && phase === "ready" && Boolean(question);
  const rendersListening = !waitingForQuestion && phase === "listening" && Boolean(question);
  const rendersThinking = phase === "thinking";
  const rendersFeedback = !waitingForEvaluation && phase === "feedback" && Boolean(question);
  const rendersCorrection = phase === "correction" && Boolean(evaluation);
  const rendersRecapHandoff = connectedRuntime && phase === "recap";
  const rendersKnownBody =
    waitingForQuestion ||
    rendersReadyPrompt ||
    rendersListening ||
    rendersThinking ||
    waitingForEvaluation ||
    waitingForCorrection ||
    rendersFeedback ||
    rendersCorrection ||
    rendersRecapHandoff;

  return (
    <div className="session-screen">
      <header className="session-top">
        <span className="chip session-context">
          <Icon color="var(--plum)" name="layers" size={15} />
          {studySet.title}
          <Icon color="var(--ink-3)" name="down" size={13} />
          <em>{modeLabels[mode]}</em>
        </span>
        {connectionStatus !== "idle" ? (
          <span className="chip session-context">
            <Icon color="var(--plum)" name="bars" size={13} />
            Agent {connectionStatus}
          </span>
        ) : null}
        {agentSpeaking ? (
          <span className="chip session-context">
            <Icon color="var(--plum)" name="bars" size={13} />
            Agent speaking
          </span>
        ) : null}
        <button className="button button-warn" onClick={onEnd} type="button">
          <span />
          End session
        </button>
      </header>
      {errors.length > 0 ? (
        <div className="session-nudge">
          <Icon color="var(--amber)" name="flag" size={16} />
          {errors[errors.length - 1]}
        </div>
      ) : null}
      {protocolNotice ? (
        <div className="session-nudge">
          <Icon color="var(--amber)" name="flag" size={16} />
          {protocolNotice}
        </div>
      ) : null}
      {waitingForQuestion ? (
        <section className="session-ready">
          <VoiceOrb size={154} state="thinking" />
          <p className="kicker">Connected agent</p>
          <h1 className="display">
            {connectionStatus === "connecting" ? "Connecting to Viva..." : "Waiting for prompt"}
          </h1>
          <p className="session-nudge">
            <Icon color="var(--plum)" name="bars" size={16} />
            The next prompt will come from the running agent.
          </p>
        </section>
      ) : null}
      {rendersReadyPrompt && question ? (
        <section className="session-ready">
          <p className="kicker">Question 1 of 8 · {modeLabels[mode]}</p>
          <h1 className="display">{question.prompt}</h1>
          <VoiceOrb size={154} state={mode === "mock" ? "recall" : "ready"} />
          <p className="session-nudge">
            <Icon color="var(--plum)" name="mic" size={16} />
            Ready for a 10-minute recall drill? Close your notes.
          </p>
          <div className="mode-row">
            {(["quiz", "teach", "mock", "cram"] as StudyMode[]).map((nextMode) => (
              <ModeChip
                active={mode === nextMode}
                key={nextMode}
                label={modeLabels[nextMode]}
                mode={nextMode}
                onClick={() => onModeChange(nextMode)}
              />
            ))}
          </div>
          <button className="button button-primary" onClick={onStart} type="button">
            <Icon color="var(--plum-soft)" name="mic" size={18} />
            Start session
          </button>
        </section>
      ) : null}
      {rendersListening && question ? (
        <section className="session-listening">
          <div className="current-question">
            <p className="cap">Current question</p>
            <h2 className="serif">{question.prompt}</h2>
          </div>
          <div className="center-stage">
            <span className="serif timer">07:32</span>
            <VoiceOrb size={196} state="listening" />
            <strong>Listening...</strong>
            <Equalizer bars={14} wide />
          </div>
          <label className="answer-box">
            <span>Your spoken answer</span>
            <textarea onChange={(event) => onAnswerChange(event.target.value)} value={answer} />
          </label>
          <div className="session-actions">
            <button
              className="button button-secondary"
              onClick={isDictating ? onStopDictation : onDictate}
              type="button"
            >
              <Icon color="var(--plum)" name={isDictating ? "pause" : "mic"} size={16} />
              {micState === "requesting"
                ? "Requesting mic"
                : isDictating
                  ? "Stop dictation"
                  : micState === "denied"
                    ? "Mic denied"
                    : micState === "unsupported"
                      ? "Mic unsupported"
                      : micState === "insecure"
                        ? "HTTPS needed"
                        : connectedRuntime
                          ? "Use browser audio"
                          : "Use browser dictation"}
            </button>
            {!connectedRuntime ? (
              <button
                className="button button-secondary"
                onClick={() =>
                  onSubmitAnswer("I think it helps make ATP by giving energy to the mitochondria.")
                }
                type="button"
              >
                Use sample answer
              </button>
            ) : null}
            <button
              disabled={!canSubmitAnswer}
              className="button button-primary"
              onClick={() => onSubmitAnswer()}
              type="button"
            >
              Check answer
            </button>
          </div>
        </section>
      ) : null}
      {rendersThinking ? (
        <section className="session-ready">
          <VoiceOrb size={174} state="thinking" />
          <h2 className="display">Checking your answer...</h2>
          <Equalizer bars={18} faint />
        </section>
      ) : null}
      {waitingForEvaluation ? (
        <section className="session-ready">
          <VoiceOrb size={174} state="thinking" />
          <h2 className="display">Waiting for feedback</h2>
          <p className="session-nudge">
            <Icon color="var(--plum)" name="bars" size={16} />
            Feedback appears after the agent evaluates your answer.
          </p>
        </section>
      ) : null}
      {waitingForCorrection ? (
        <section className="session-ready">
          <VoiceOrb size={174} state="thinking" />
          <h2 className="display">Waiting for correction</h2>
          <p className="session-nudge">
            <Icon color="var(--plum)" name="bars" size={16} />
            The source-backed correction will appear after the agent evaluation arrives.
          </p>
        </section>
      ) : null}
      {connectedRuntime && phase === "recap" ? (
        <section className="session-ready">
          <VoiceOrb size={174} state="ready" />
          <p className="kicker">Connected agent</p>
          <h2 className="display">Recap ready</h2>
          <p className="session-nudge">
            <Icon color="var(--plum)" name="bars" size={16} />
            The agent has finished this drill and prepared the source-backed recap.
          </p>
          <button className="button button-primary" onClick={onEnd} type="button">
            <Icon color="var(--plum-soft)" name="bars" size={18} />
            View recap
          </button>
        </section>
      ) : null}
      {connectedRuntime && !rendersKnownBody ? (
        <section className="session-ready">
          <VoiceOrb size={174} state="thinking" />
          <p className="kicker">Connected agent</p>
          <h2 className="display">Agent state updating</h2>
          <p className="session-nudge">
            <Icon color="var(--plum)" name="bars" size={16} />
            Viva is waiting for the next renderable agent payload for phase {phase}.
          </p>
        </section>
      ) : null}
      {rendersFeedback && question ? (
        <section className="session-feedback">
          <aside className="transcript-panel">
            <p className="kicker">Live transcript</p>
            <TranscriptLine text={question.prompt} time="07:02" who="viva" />
            <TranscriptLine
              text={
                transcript ||
                answer ||
                (!connectedRuntime
                  ? "I think it helps make ATP by giving energy to the mitochondria."
                  : "Transcript unavailable from agent.")
              }
              time="07:18"
              who="you"
            />
            <TranscriptLine
              text={
                evaluation?.conciseFeedback ??
                (!connectedRuntime ? "Good start, but the mechanism is missing." : "")
              }
              time="07:28"
              who="viva"
            />
          </aside>
          <div className="feedback-orb">
            <span className="serif timer">07:32</span>
            <VoiceOrb size={174} state="thinking" />
            <strong>Responding...</strong>
          </div>
          <aside className="feedback-actions">
            <p className="kicker">What's next?</p>
            <FeedbackCard
              body={evaluation?.retryPrompt ?? "Explain using the shuttle systems"}
              icon="pen"
              onClick={onShowCorrection}
              title="Try again with an example"
            />
            {!connectedRuntime ? (
              <FeedbackCard
                accent="gold"
                body="A nudge, not the answer"
                icon="bulb"
                title="Need a hint?"
              />
            ) : null}
            <FeedbackCard
              body={evaluation?.source.label ?? question.source.label}
              icon="doc"
              onClick={onShowCorrection}
              title="Show source"
            />
            {!connectedRuntime ? (
              <FeedbackCard
                accent="amber"
                body="Bring it back tomorrow"
                icon="flag"
                title="Mark as shaky"
              />
            ) : null}
          </aside>
        </section>
      ) : null}
      {rendersCorrection ? (
        evaluation ? (
          <CorrectionScreen
            answer={connectedRuntime ? transcript : answer}
            connectedRuntime={connectedRuntime}
            evaluation={evaluation}
            onEnd={onEnd}
            onRetry={onRetryAnswer}
          />
        ) : null
      ) : null}
    </div>
  );
}

export function CorrectionScreen({
  answer,
  connectedRuntime,
  evaluation,
  onEnd,
  onRetry,
}: {
  answer: string;
  connectedRuntime: boolean;
  evaluation: AnswerEvaluation;
  onEnd: () => void;
  onRetry: () => void;
}) {
  const lowConfidence = evaluation.source.confidence === "low";

  return (
    <section className="correction-screen">
      <div className="correction-heading">
        <VoiceOrb size={92} state="correcting" />
        <div>
          <p className="kicker">Gentle correction</p>
          <h2 className="display">Almost - let's sharpen it.</h2>
        </div>
      </div>
      <div className="correction-grid">
        <article className="correction-card">
          <div className="said-row">
            <strong>You said</strong>
            <span>{correctionQuote(answer)}</span>
          </div>
          <hr />
          <p className="serif">"{evaluation.conciseFeedback}"</p>
          {lowConfidence ? (
            <small>Source confidence is low. Viva would avoid pretending certainty here.</small>
          ) : null}
          <div className="correction-meta">
            <MasteryChip label="Marked shaky" tier={evaluation.conceptStatus} />
            <span>Confidence {Math.round(evaluation.confidenceScore * 100)}%</span>
          </div>
        </article>
        <article className="source-card">
          <p className="kicker">
            <Icon color="var(--plum)" name="doc" size={13} />
            Source
          </p>
          <div className="source-excerpt">
            <span className="cap">{evaluation.source.label}</span>
            <strong>Course-specific correction</strong>
            <p>{evaluation.source.excerpt}</p>
          </div>
          <div className="correction-meta">
            <span>Confidence {evaluation.source.confidence}</span>
            {evaluation.source.sourceId ? <span>Source {evaluation.source.sourceId}</span> : null}
            {evaluation.source.documentId ? (
              <span>Document {evaluation.source.documentId}</span>
            ) : null}
            {evaluation.source.span ? <span>Span {evaluation.source.span}</span> : null}
            {evaluation.source.retrievalReason ? (
              <span>{evaluation.source.retrievalReason}</span>
            ) : null}
          </div>
          <SourceChip label={`Open in ${evaluation.source.label}`} />
        </article>
      </div>
      <div className="session-actions">
        <button className="button button-primary" onClick={onRetry} type="button">
          <Icon color="var(--plum-soft)" name="refresh" size={16} />
          Try again
        </button>
        {!connectedRuntime ? (
          <button className="button button-secondary" type="button">
            <Icon color="var(--plum)" name="cap" size={16} />
            Explain with shuttle systems
          </button>
        ) : null}
        <button className="button button-secondary" onClick={onEnd} type="button">
          End with recap
        </button>
      </div>
    </section>
  );
}

export function RecapScreen({
  connectedRuntime,
  onAnotherDrill,
  onSchedule,
  recap,
}: {
  connectedRuntime: boolean;
  onAnotherDrill: () => void;
  onSchedule: () => void;
  recap: SessionRecap;
}) {
  const stats = recapStats(recap);

  return (
    <div className="recap-screen">
      <header className="screen-topbar">
        <span className="chip">
          <Icon color="var(--plum)" name="cal" size={16} />
          <strong>Session recap</strong>
          <span>· {recap.durationLabel}</span>
        </span>
        {!connectedRuntime ? (
          <button className="button button-secondary" type="button">
            <Icon color="var(--plum)" name="share" size={15} />
            Share
          </button>
        ) : null}
      </header>
      <section className="recap-hero">
        <VoiceOrb size={56} state="encouraging" />
        <h1 className="display">{recap.headline}</h1>
        <p>{recap.summary}</p>
      </section>
      <section className="recap-stats">
        {stats.map((stat) => (
          <StatCard key={stat.label} {...stat} />
        ))}
      </section>
      <section className="recap-grid">
        <article className="soft-card study-plan-card">
          <p className="kicker">Your generated study plan</p>
          {recap.plan.map((item, index) => (
            <TimelineItem key={item.day} last={index === recap.plan.length - 1} {...item} />
          ))}
        </article>
        <article className="soft-card moments-card">
          <p className="kicker">
            <Spark color="var(--plum)" size={13} />
            Moments worth revisiting
          </p>
          {recap.sourceMoments.map((moment) => (
            <div
              className={`moment moment--${moment.status}`}
              key={`${moment.source.label}-${moment.text}`}
            >
              <span />
              <p>{moment.text}</p>
              <SourceChip label={moment.source.label} />
            </div>
          ))}
        </article>
      </section>
      <div className="recap-actions">
        {!connectedRuntime ? (
          <button className="button button-primary" onClick={onSchedule} type="button">
            <Icon color="var(--plum-soft)" name="cal" size={17} />
            {recap.nextAction}
          </button>
        ) : null}
        <button className="button button-secondary" onClick={onAnotherDrill} type="button">
          <Icon color="var(--plum)" name="mic" size={16} />
          Another 5-min drill
        </button>
      </div>
    </div>
  );
}

function StatCard({
  label,
  pct,
  topics,
  color,
}: {
  label: string;
  pct: number;
  topics: number;
  color: string;
}) {
  return (
    <article className="stat-card">
      <MasteryRing color={color} pct={pct} size={86} />
      <div>
        <strong style={{ color }}>{label}</strong>
        <span className="serif">
          {topics}
          <small> topics</small>
        </span>
      </div>
    </article>
  );
}

function LibraryScreen({
  expandedSetId,
  onArchive,
  onDeleteDocument,
  onExpand,
  onNewStudySet,
  onResume,
  studySets,
}: {
  expandedSetId: string;
  onArchive: (studySetId: string) => void;
  onDeleteDocument: (studySetId: string, documentId: string) => void;
  onExpand: (studySetId: string) => void;
  onNewStudySet: () => void;
  onResume: (studySetId: string) => void;
  studySets: StudySet[];
}) {
  return (
    <div className="library-screen">
      <header className="screen-topbar">
        <div>
          <h1 className="display">Library</h1>
          <span>{studySets.length} study sets · 1 exam this week</span>
        </div>
        <button className="button button-primary" onClick={onNewStudySet} type="button">
          <Icon color="var(--plum-soft)" name="plus" size={16} />
          New study set
        </button>
      </header>
      <section className="study-set-grid">
        {studySets.map((studySet) => (
          <article className="study-set-card" key={studySet.id}>
            <button
              className="study-set-card__main"
              onClick={() => onExpand(studySet.id)}
              type="button"
            >
              <span>
                <strong className="display">{studySet.title}</strong>
                <small>
                  {studySet.docs.length} docs · {studySet.lastSessionLabel}
                </small>
              </span>
              <VoiceOrb size={44} state={studySet.mastery.shaky > 20 ? "ready" : "encouraging"} />
            </button>
            <span className="chip exam-chip">
              <Icon
                color={studySet.examDateLabel.includes("Friday") ? "var(--amber)" : "var(--ink-3)"}
                name="cal"
                size={13}
              />
              {studySet.examDateLabel}
            </span>
            <div className="mastery-stack">
              <span>
                <small>Mastery</small>
                <strong>{studySet.mastery.strong}% strong</strong>
              </span>
              <div className="mastery-bar">
                <span style={{ width: `${studySet.mastery.strong}%` }} />
                <span style={{ width: `${studySet.mastery.shaky}%` }} />
                <span style={{ width: `${studySet.mastery.review}%` }} />
              </div>
            </div>
            <button className="study-set-next" onClick={() => onResume(studySet.id)} type="button">
              <span>
                <Icon color="var(--plum)" name="mic" size={15} />
                Next: {studySet.recommendedSession}
              </span>
              <Icon color="var(--plum)" name="arrow" size={16} />
            </button>
            {expandedSetId === studySet.id ? (
              <div className="document-list">
                <p className="kicker">Documents</p>
                {studySet.docs.map((document) => (
                  <span className="document-row" key={document.id}>
                    <Icon color="var(--plum)" name="doc" size={15} />
                    <strong>{document.name}</strong>
                    <small>{documentMetaLabel(document)}</small>
                    <button
                      aria-label={`Delete ${document.name}`}
                      onClick={() => onDeleteDocument(studySet.id, document.id)}
                      type="button"
                    >
                      <Icon color="var(--ink-3)" name="trash" size={14} />
                    </button>
                  </span>
                ))}
                <div className="library-card-actions">
                  <button className="text-button" onClick={onNewStudySet} type="button">
                    Add documents
                  </button>
                  <button
                    className="text-button"
                    onClick={() => onArchive(studySet.id)}
                    type="button"
                  >
                    Archive study set
                  </button>
                </div>
              </div>
            ) : null}
          </article>
        ))}
        <button
          className="study-set-card study-set-card--add"
          onClick={onNewStudySet}
          type="button"
        >
          <span className="dropzone__icon">
            <Icon color="var(--plum)" name="upload" size={22} />
          </span>
          <strong>Add a study set</strong>
          <small>Drop notes, slides, or a PDF</small>
        </button>
      </section>
    </div>
  );
}

function speak(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.98;
  utterance.pitch = 0.92;
  window.speechSynthesis.speak(utterance);
}
