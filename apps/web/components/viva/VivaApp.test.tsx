import { describe, expect, test } from "bun:test";
import {
  type AnswerEvaluation,
  createStudySetPreview,
  type SessionPhase,
  type SessionRecap,
  type StudyMode,
  sampleQuestion,
  seedStudySets,
} from "@viva/core";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CorrectionScreen,
  HomeScreen,
  RecapScreen,
  SessionScreen,
  shouldStopConnectedAudioForRecap,
  UploadScreen,
} from "./VivaApp";

const noop = () => {};

describe("VivaApp component states", () => {
  test("connected session waits for agent prompt without rendering local demo question", () => {
    const markup = renderSession({ connectedRuntime: true, phase: "listening" });

    expect(markup).toContain("Waiting for prompt");
    expect(markup).toContain("The next prompt will come from the running agent.");
    expect(markup).not.toContain(sampleQuestion.prompt);
    expect(markup).not.toContain("Use sample answer");
  });

  test("connected feedback waits for agent evaluation without local feedback fallback", () => {
    const markup = renderSession({
      connectedRuntime: true,
      phase: "feedback",
      question: sampleQuestion,
    });

    expect(markup).toContain("Waiting for feedback");
    expect(markup).toContain("Feedback appears after the agent evaluates your answer.");
    expect(markup).not.toContain("Good start, but the mechanism is missing.");
  });

  test("connected correction waits for agent evaluation without rendering blank", () => {
    const markup = renderSession({
      connectedRuntime: true,
      phase: "correction",
      question: sampleQuestion,
    });

    expect(markup).toContain("Waiting for correction");
    expect(markup).toContain("source-backed correction");
    expect(markup).not.toContain("Almost - let&#x27;s sharpen it.");
  });

  test("connected feedback hides local-only hint and mutation actions", () => {
    const markup = renderSession({
      connectedRuntime: true,
      evaluation: trustedEvaluation,
      phase: "feedback",
      question: sampleQuestion,
    });

    expect(markup).toContain("Try again with an example");
    expect(markup).toContain("Show source");
    expect(markup).not.toContain("Need a hint?");
    expect(markup).not.toContain("Mark as shaky");
  });

  test("connected recap phase renders a nonblank handoff state", () => {
    const markup = renderSession({
      connectedRuntime: true,
      phase: "recap",
      question: sampleQuestion,
    });

    expect(markup).toContain("Recap ready");
    expect(markup).toContain("source-backed recap");
    expect(markup).toContain("View recap");
  });

  test("connected unknown agent phase renders a diagnostic fallback", () => {
    const markup = renderSession({
      connectedRuntime: true,
      phase: "agent-paused" as SessionPhase,
      question: sampleQuestion,
    });

    expect(markup).toContain("Agent state updating");
    expect(markup).toContain("phase agent-paused");
  });

  test("home disables connected agent for pending local previews", () => {
    const studySet = createStudySetPreview({
      courseName: "Biology Midterm",
      pastedText: "NADH and oxidative phosphorylation notes.",
    });
    const markup = renderToStaticMarkup(
      <HomeScreen
        agentReadiness={{
          canConnect: false,
          reason: "pending_ingestion",
          message:
            "Connected agent is unavailable until source-grounded ingestion returns concepts and processed documents.",
        }}
        canStartConnectedAgent={false}
        mode="quiz"
        onModeChange={noop}
        onStartDemo={noop}
        onStartSession={noop}
        onUpload={noop}
        studySet={studySet}
      />,
    );

    expect(markup).toContain("Agent unavailable");
    expect(markup).toContain("Run local demo drill");
    expect(markup).toContain("source-grounded ingestion");
    expect(markup).toContain('disabled=""');
  });

  test("mic states render explicit labels", () => {
    expect(renderSession({ question: sampleQuestion, micState: "requesting" })).toContain(
      "Requesting mic",
    );
    expect(renderSession({ question: sampleQuestion, micState: "denied" })).toContain("Mic denied");
    expect(renderSession({ question: sampleQuestion, micState: "unsupported" })).toContain(
      "Mic unsupported",
    );
    expect(renderSession({ question: sampleQuestion, micState: "insecure" })).toContain(
      "HTTPS needed",
    );
    expect(
      renderSession({ question: sampleQuestion, micState: "listening", isDictating: true }),
    ).toContain("Stop dictation");
  });

  test("initial upload form disables preview generation until input exists", () => {
    const markup = renderToStaticMarkup(
      <UploadScreen
        accountCreated={false}
        onCreateAccount={noop}
        onCreateStudySet={noop}
        onEnterHome={noop}
        processing={false}
        progress={0}
        studySet={seedStudySets[0]}
        uploadNotice={null}
      />,
    );

    expect(markup).toContain("Generate local preview");
    expect(markup).toContain('disabled=""');
  });

  test("upload preview does not invent files or extracted concepts", () => {
    const studySet = createStudySetPreview({
      courseName: "Chemistry Final",
      pastedText: "SN1 and SN2 notes.",
      fileNames: [],
    });
    const markup = renderToStaticMarkup(
      <UploadScreen
        accountCreated={false}
        onCreateAccount={noop}
        onCreateStudySet={noop}
        onEnterHome={noop}
        processing={false}
        progress={100}
        studySet={studySet}
        uploadNotice={null}
      />,
    );

    expect(markup).toContain("Awaiting real concept extraction");
    expect(markup).toContain("Pasted notes");
    expect(markup).toContain("Pending extraction");
    expect(markup).not.toContain("Lecture notes.pdf");
    expect(markup).not.toContain("24 pages");
    expect(markup).not.toContain("9 pages");
    expect(markup).not.toContain("testable concepts found");
  });

  test("upload preview surfaces server ingestion status and fallback failures", () => {
    const studySet = {
      ...seedStudySets[0],
      serverOwned: true,
      ingestionStatus: "processing" as const,
      lastSessionLabel: "Server ingestion processing",
    };
    const markup = renderToStaticMarkup(
      <UploadScreen
        accountCreated
        onCreateAccount={noop}
        onCreateStudySet={noop}
        onEnterHome={noop}
        processing={false}
        progress={100}
        studySet={studySet}
        uploadNotice="Server paste ingestion failed. Local pending preview generated."
      />,
    );

    expect(markup).toContain("Server study set");
    expect(markup).toContain("Ingestion processing");
    expect(markup).toContain("Server paste ingestion failed");
  });

  test("connected correction preserves source tuple and hides local-only explanation action", () => {
    const markup = renderToStaticMarkup(
      <CorrectionScreen
        answer="NADH donates electrons."
        connectedRuntime
        evaluation={trustedEvaluation}
        onEnd={noop}
        onRetry={noop}
      />,
    );

    expect(markup).toContain("Source src-lecture-5-slide-18");
    expect(markup).toContain("Document lec-5");
    expect(markup).toContain("Span slide:18");
    expect(markup).toContain("server fixture source");
    expect(markup).not.toContain("Explain with shuttle systems");
  });

  test("connected recap hides local-only share and schedule actions", () => {
    const markup = renderToStaticMarkup(
      <RecapScreen connectedRuntime onAnotherDrill={noop} onSchedule={noop} recap={trustedRecap} />,
    );

    expect(markup).toContain("Session recap");
    expect(markup).toContain("Another 5-min drill");
    expect(markup).not.toContain("Share");
    expect(markup).not.toContain(trustedRecap.nextAction);
  });

  test("connected recap arrival is the mic capture stop boundary", () => {
    expect(
      shouldStopConnectedAudioForRecap({
        hasRecap: true,
        runtimeMode: "connected-agent",
        view: "session",
      }),
    ).toBe(true);
    expect(
      shouldStopConnectedAudioForRecap({
        hasRecap: true,
        runtimeMode: "connected-agent",
        view: "recap",
      }),
    ).toBe(false);
    expect(
      shouldStopConnectedAudioForRecap({
        hasRecap: true,
        runtimeMode: "local-demo",
        view: "session",
      }),
    ).toBe(false);
    expect(
      shouldStopConnectedAudioForRecap({
        hasRecap: false,
        runtimeMode: "connected-agent",
        view: "session",
      }),
    ).toBe(false);
  });
});

function renderSession({
  connectedRuntime = false,
  phase = "listening",
  question,
  evaluation = null,
  micState = "idle",
  isDictating = false,
}: {
  connectedRuntime?: boolean;
  phase?: SessionPhase;
  question?: typeof sampleQuestion;
  evaluation?: AnswerEvaluation | null;
  micState?: "idle" | "requesting" | "listening" | "denied" | "unsupported" | "insecure";
  isDictating?: boolean;
}) {
  return renderToStaticMarkup(
    <SessionScreen
      answer=""
      canSubmitAnswer
      connectedRuntime={connectedRuntime}
      connectionStatus={connectedRuntime ? "open" : "idle"}
      errors={[]}
      evaluation={evaluation}
      isDictating={isDictating}
      micState={micState}
      mode={"quiz" as StudyMode}
      onAnswerChange={noop}
      onDictate={noop}
      onEnd={noop}
      onModeChange={noop}
      onRetryAnswer={noop}
      onShowCorrection={noop}
      onStart={noop}
      onStopDictation={noop}
      onSubmitAnswer={noop}
      phase={phase}
      protocolNotice={null}
      question={question}
      studySet={seedStudySets[0]}
      transcript=""
    />,
  );
}

const trustedEvaluation: AnswerEvaluation = {
  label: "mostly correct",
  correctionKind: "correct but incomplete",
  conciseFeedback: "Good mechanism. Add the gradient-to-synthase link.",
  retryPrompt: "Connect proton gradient to ATP synthase.",
  source: {
    confidence: "high",
    documentId: "lec-5",
    excerpt: "NADH donates high-energy electrons to the electron transport chain.",
    label: "Lecture 5 · Slide 18",
    retrievalReason: "server fixture source",
    sourceId: "src-lecture-5-slide-18",
    span: "slide:18",
  },
  conceptStatus: "strong",
  confidenceScore: 0.88,
};

const trustedRecap: SessionRecap = {
  headline: "Session complete",
  durationLabel: "Agent session",
  summary: "You completed the connected agent drill.",
  strongConcepts: ["Oxidative phosphorylation"],
  shakyConcepts: [],
  missedConcepts: [],
  reviewLater: ["ATP synthase"],
  nextAction: "Schedule tomorrow's recall drill",
  sourceMoments: [
    {
      text: "Connected source-backed correction.",
      source: trustedEvaluation.source,
      status: "strong",
    },
  ],
  plan: [
    {
      day: "Now",
      topics: "Oxidative phosphorylation",
      meta: "completed",
      status: "done",
    },
  ],
};
