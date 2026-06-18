import { describe, expect, test } from "bun:test";
import {
  type AgentStudySetReadiness,
  type ReviewScheduleItem,
  type SessionRecap,
  VIVA_VOICE_PROTOCOL_VERSION,
  type VivaReadyFrame,
} from "@viva/core";
import { renderToStaticMarkup } from "react-dom/server";
import type { VivaSceneState } from "../../lib/viva-scene-reducer";
import {
  projectRuntimeCopy,
  type RuntimeCopy,
  type SourceFolioProjection,
} from "../../lib/viva-session-projection";
import { MarginaliaPanel } from "./MarginaliaPanel";
import { SessionHeader } from "./SessionHeader";
import type { Question } from "./session-data";
import {
  planVoiceTraceConceptLabels,
  VoiceTraceCanvas,
  voiceTraceBloomPulse,
} from "./VoiceTraceCanvas";

const noop = () => {};

const question: Question = {
  prompt: "Explain the role of NADH.",
  checklist: [],
  correctionBody: "",
  explanation: "",
  sourceRef: "",
  sourceSubtitle: "",
  excerpt: "",
  sourceFooter: "",
  status: "",
  highlights: [],
};

const scene: VivaSceneState = {
  register: "correcting",
  emphasis: "marked",
  emphasisWeight: 0.9,
  entities: [
    {
      id: "nadh",
      kind: "concept",
      register: "correcting",
      emphasis: "marked",
      emphasisWeight: 0.9,
    },
  ],
  marginalia: [
    {
      id: "hint-1",
      anchorEntityId: "nadh",
      register: "reflecting",
      emphasis: "quiet",
      emphasisWeight: 0.25,
    },
  ],
};

const runtime: RuntimeCopy = {
  capsuleLabel: "Synthetic examiner",
  marginaliaTitle: "Synthetic examiner is listening.",
  marginaliaText: "Default no-key synthetic brain.",
  nextActionLabel: "Answer when ready",
  primaryActionDisabled: false,
  primaryActionIntent: "submit_turn",
  primaryActionLabel: "I'm ready — check it",
  readinessNotes: [{ label: "Provider", state: "ready", text: "Synthetic brain ready." }],
  statusLabel: "synthetic",
  cause: "synthetic",
};

const trustedReadiness: AgentStudySetReadiness = {
  canConnect: true,
  reason: "trusted",
  message: "Connected agent is mapped to a trusted server study set.",
};

const trustedRecap: SessionRecap = {
  durationLabel: "Agent session",
  headline: "Server recap headline",
  missedConcepts: [],
  nextAction: "Review the ATP synthase source span before the next call.",
  plan: [],
  reviewLater: ["proton gradient", "ATP synthase"],
  shakyConcepts: ["proton gradient"],
  sourceMoments: [
    {
      source: {
        confidence: "high",
        excerpt: "Electron flow pumps protons across the inner mitochondrial membrane.",
        label: "Lecture 5 · Slide 18",
      },
      status: "strong",
      text: "Question source: oxidative phosphorylation.",
    },
  ],
  strongConcepts: ["electron donor"],
  summary: "The Conductor recap stayed grounded to the server-owned source span.",
};

const trustedReviewPlan: ReviewScheduleItem[] = [
  {
    authority: "core_fsrs",
    conceptId: "atp-synthase",
    dueAt: new Date("2026-06-18T12:00:00.000Z"),
    explanation: ["FSRS rating: Hard", "hint-assisted answer lowered the rating"],
    intervalLabel: "tomorrow",
    label: "ATP yield",
    priority: "urgent",
    status: "missed",
  },
];

const sourceFolio: SourceFolioProjection = {
  caveat: "Source citation is bounded to this server-owned span.",
  challengeLabel: "Challenge citation",
  conceptStatus: "Shaky · review tomorrow",
  confidenceLabel: "High confidence",
  regionNavigation: "Document span only; exact page and bounding-box navigation is unverified.",
  source: {
    confidence: "high",
    documentId: "lec-5",
    excerpt: "Bounded source_reference excerpt, not the full uploaded lecture.",
    label: "Lecture 5 · Slide 18",
    retrievalReason: "server fixture source for oxidative phosphorylation",
    sourceId: "src-lecture-5-slide-18",
    span: "slide:18",
  },
  state: "present",
};

const denseConceptNodes = [
  { id: "nadh", label: "NADH", status: "strong", emphasis: 0.65 },
  { id: "complex-i", label: "Complex I", status: "review", emphasis: 0.35 },
  { id: "ubiquinone", label: "Ubiquinone shuttle", status: "shaky", emphasis: 0.8 },
  { id: "complex-iii", label: "Complex III", status: "review", emphasis: 0.4 },
  { id: "proton-gradient", label: "Proton gradient", status: "missed", emphasis: 1 },
  { id: "atp-synthase", label: "ATP synthase", status: "shaky", emphasis: 0.95 },
  { id: "oxygen", label: "Oxygen acceptor", status: "review", emphasis: 0.55 },
] as const;

function ready(provider: string, overrides: Partial<VivaReadyFrame["brain"]> = {}): VivaReadyFrame {
  return {
    type: "ready",
    version: VIVA_VOICE_PROTOCOL_VERSION,
    sample_rate_hz: 24000,
    input_encoding: "pcm_s16le",
    brain: {
      provider,
      configured: true,
      selectable: true,
      live_runtime: false,
      ...overrides,
    },
    store: {
      backend: "in_memory",
      available: true,
      durable: false,
      raw_audio_persistence: false,
      transcript_persistence: false,
      uuid_schema_translation: true,
    },
  };
}

function renderRuntimeSurfaces(runtimeCopy: RuntimeCopy): string {
  return renderToStaticMarkup(
    <>
      <SessionHeader
        clockLabel="Fixture clock"
        contextLabel="Trusted server set: Biology Midterm"
        elapsed={5}
        runtime={runtimeCopy}
      />
      <MarginaliaPanel
        hintShown={false}
        onBackToQuestion={noop}
        onHint={noop}
        onNextQuestion={noop}
        onShowSource={noop}
        onSubmitAnswer={noop}
        onTryAgain={noop}
        question={question}
        runtime={runtimeCopy}
        state="listening"
      />
    </>,
  );
}

function renderSourceFolioSurface(overrides: Partial<SourceFolioProjection> = {}): string {
  return renderToStaticMarkup(
    <MarginaliaPanel
      hintShown={false}
      onBackToQuestion={noop}
      onHint={noop}
      onNextQuestion={noop}
      onShowSource={noop}
      onSubmitAnswer={noop}
      onTryAgain={noop}
      question={question}
      runtime={runtime}
      sourceFolio={{ ...sourceFolio, ...overrides }}
      state="source"
    />,
  );
}

describe("LiveSessionShell scene intent wiring", () => {
  test("labels connected header fixture content and its local clock explicitly", () => {
    const markup = renderToStaticMarkup(
      <SessionHeader
        clockLabel="Fixture clock"
        contextLabel="Trusted server set: Biology Midterm"
        elapsed={5}
        runtime={runtime}
      />,
    );

    expect(markup).toContain("Trusted server set: Biology Midterm");
    expect(markup).toContain("Fixture clock 00:05");
    expect(markup).not.toContain('session-capsule__primary">Biology Midterm</span>');
    expect(markup).not.toContain('session-capsule__time">00:05</span>');
  });

  test("renders scene state onto the existing Canvas and marginalia surfaces", () => {
    const canvasMarkup = renderToStaticMarkup(
      <VoiceTraceCanvas
        conceptNodes={[...denseConceptNodes]}
        scene={scene}
        state="correction"
        textMode={true}
      />,
    );
    const marginaliaMarkup = renderToStaticMarkup(
      <MarginaliaPanel
        hintShown={false}
        onBackToQuestion={noop}
        onHint={noop}
        onNextQuestion={noop}
        onShowSource={noop}
        onSubmitAnswer={noop}
        onTryAgain={noop}
        question={question}
        runtime={runtime}
        scene={scene}
        state="correction"
      />,
    );

    expect(canvasMarkup).toContain('class="voice-trace"');
    expect(canvasMarkup).toContain('data-scene-register="correcting"');
    expect(canvasMarkup).toContain('data-scene-emphasis="marked"');
    expect(canvasMarkup).toContain('data-scene-entity-count="1"');
    expect(canvasMarkup).toContain('data-concept-count="7"');
    expect(canvasMarkup).toContain('data-concept-density="dense"');
    expect(canvasMarkup).toContain('data-text-mode="true"');
    expect(marginaliaMarkup).toContain('class="marginalia"');
    expect(marginaliaMarkup).toContain('data-scene-register="correcting"');
    expect(marginaliaMarkup).toContain('data-scene-marginalia-count="1"');
    expect(`${canvasMarkup}${marginaliaMarkup}`).not.toContain("Render instruction");
  });

  test("keeps the bloom at a constant floor in text mode", () => {
    expect(voiceTraceBloomPulse({ textMode: true, time: 0, voice: 0 })).toBe(
      voiceTraceBloomPulse({ textMode: true, time: 10, voice: 1 }),
    );
    expect(voiceTraceBloomPulse({ textMode: false, time: 0, voice: 0 })).not.toBe(
      voiceTraceBloomPulse({ textMode: false, time: 10, voice: 0 }),
    );
  });

  test("plans dense concept labels into bounded non-overlapping lanes", () => {
    const labels = planVoiceTraceConceptLabels({
      canvasHeight: 180,
      canvasWidth: 420,
      fontScale: 0.72,
      items: denseConceptNodes.map((node, index) => ({
        emphasis: node.emphasis,
        label: node.label,
        point: {
          x: 44 + index * 55,
          y: index % 2 === 0 ? 88 : 70,
        },
      })),
    });

    expect(labels).toHaveLength(denseConceptNodes.length);
    expect(labels.some((label) => label.leaderLine)).toBe(true);

    for (const label of labels) {
      expect(label.text.length).toBeGreaterThan(0);
      expect(label.hidden).toBe(false);
      expect(label.box.left).toBeGreaterThanOrEqual(8);
      expect(label.box.right).toBeLessThanOrEqual(412);
      expect(label.box.top).toBeGreaterThanOrEqual(8);
      expect(label.box.bottom).toBeLessThanOrEqual(172);
    }

    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        expect(boxesOverlap(labels[i].box, labels[j].box)).toBe(false);
      }
    }
  });

  test("renders projected runtime copy in listening marginalia", () => {
    const markup = renderToStaticMarkup(
      <MarginaliaPanel
        hintShown={false}
        onBackToQuestion={noop}
        onHint={noop}
        onNextQuestion={noop}
        onShowSource={noop}
        onSubmitAnswer={noop}
        onTryAgain={noop}
        question={question}
        runtime={runtime}
        state="listening"
      />,
    );

    expect(markup).toContain("Synthetic examiner is listening.");
    expect(markup).toContain("Default no-key synthetic brain.");
    expect(markup).toContain("Synthetic brain ready.");
    expect(markup).toContain("Answer when ready");
    expect(markup).not.toContain("live tutor");
  });

  test("renders fake provider readiness as a non-live test path", () => {
    const markup = renderRuntimeSurfaces(
      projectRuntimeCopy({
        readiness: trustedReadiness,
        ready: ready("fake_cartesia_gemini"),
        status: "open",
      }),
    );

    expect(markup).toContain("Non-live provider test");
    expect(markup).toContain("Cartesia/Gemini-shaped");
    expect(markup).toContain("not a live tutor");
  });

  test("renders live provider readiness as gated until selectable", () => {
    const markup = renderRuntimeSurfaces(
      projectRuntimeCopy({
        readiness: trustedReadiness,
        ready: ready("cartesia_gemini", {
          configured: false,
          selectable: false,
          live_runtime: false,
        }),
        status: "open",
      }),
    );

    expect(markup).toContain("Live provider gated");
    expect(markup).toContain("Agent unavailable: live provider gated.");
    expect(markup).toContain("Retry when live runtime is ready");
    expect(markup).toContain("disabled");
    expect(markup).not.toContain("Live Cartesia/Gemini tutor is listening.");
    expect(markup).not.toContain("Run local demo");
  });

  test("keeps connected hints generic instead of leaking fixture answer terms", () => {
    const markup = renderToStaticMarkup(
      <MarginaliaPanel
        hintShown={true}
        onBackToQuestion={noop}
        onHint={noop}
        onNextQuestion={noop}
        onShowSource={noop}
        onSubmitAnswer={noop}
        onTryAgain={noop}
        question={question}
        runtime={runtime}
        state="listening"
      />,
    );

    expect(markup).toContain("Use your own words");
    expect(markup).not.toContain("NADH");
    expect(markup).not.toContain("electrons");
  });

  test("renders mic-denied written answer as the student's hand in the margin", () => {
    const markup = renderToStaticMarkup(
      <MarginaliaPanel
        hintShown={false}
        onBackToQuestion={noop}
        onHint={noop}
        onNextQuestion={noop}
        onShowSource={noop}
        onSubmitAnswer={noop}
        onSubmitTextAnswer={noop}
        onTryAgain={noop}
        question={question}
        runtime={runtime}
        state="listening"
        textAnswer={{
          active: true,
          disabled: false,
          lastAnswer: "NADH donates electrons to the ETC.",
          required: true,
        }}
      />,
    );

    expect(markup).toContain('data-text-answer="active"');
    expect(markup).toContain("Student");
    expect(markup).toContain("hand");
    expect(markup).toContain("NADH donates electrons");
    expect(markup).toContain("<textarea");
    expect(markup).toContain("Submit written answer");
    expect(markup).not.toContain("chat");
    expect(markup).not.toContain("generic textarea");
  });

  test("offers opt-in written answers without opening a textbox until selected", () => {
    const markup = renderToStaticMarkup(
      <MarginaliaPanel
        hintShown={false}
        onBackToQuestion={noop}
        onHint={noop}
        onNextQuestion={noop}
        onShowSource={noop}
        onSubmitAnswer={noop}
        onSubmitTextAnswer={noop}
        onTryAgain={noop}
        onUseTextAnswer={noop}
        question={question}
        runtime={runtime}
        state="listening"
        textAnswer={{
          active: false,
          disabled: false,
          required: false,
        }}
      />,
    );

    expect(markup).toContain("Write answer");
    expect(markup).not.toContain("<textarea");
  });

  test("keeps the student's hand visible while the agent evaluates the typed answer", () => {
    const markup = renderToStaticMarkup(
      <MarginaliaPanel
        hintShown={false}
        onBackToQuestion={noop}
        onHint={noop}
        onNextQuestion={noop}
        onShowSource={noop}
        onSubmitAnswer={noop}
        onSubmitTextAnswer={noop}
        onTryAgain={noop}
        question={question}
        runtime={runtime}
        state="correction"
        textAnswer={{
          active: true,
          disabled: false,
          lastAnswer: "NADH donates electrons to the transport chain.",
          required: true,
        }}
      />,
    );

    expect(markup).toContain("Student&#x27;s hand");
    expect(markup).toContain("NADH donates electrons to the transport chain.");
    expect(markup).toContain("Almost.");
  });

  test("renders connected recap payloads without local-only actions", () => {
    const markup = renderToStaticMarkup(
      <MarginaliaPanel
        hintShown={false}
        onBackToQuestion={noop}
        onHint={noop}
        onNextQuestion={noop}
        onShowSource={noop}
        onSubmitAnswer={noop}
        onTryAgain={noop}
        question={question}
        recap={trustedRecap}
        reviewPlan={trustedReviewPlan}
        runtime={runtime}
        state="source"
      />,
    );

    expect(markup).toContain("Recap ready");
    expect(markup).toContain("Server recap headline");
    expect(markup).toContain("The Conductor recap stayed grounded");
    expect(markup).toContain("Review later");
    expect(markup).toContain("proton gradient");
    expect(markup).toContain("Next session");
    expect(markup).toContain("ATP yield");
    expect(markup).toContain("core FSRS");
    expect(markup).toContain("Review the ATP synthase source span");
    expect(markup).not.toContain("Share");
    expect(markup).not.toContain("Add to calendar");
    expect(markup).not.toContain("Back to question");
  });

  test("renders source_reference folio as a bounded museum label", () => {
    const markup = renderSourceFolioSurface();

    expect(markup).toContain("Source Folio");
    expect(markup).toContain("Lecture 5 · Slide 18");
    expect(markup).toContain("Shaky · review tomorrow");
    expect(markup).toContain("High confidence");
    expect(markup).toContain("Bounded source_reference excerpt");
    expect(markup).toContain("Document span only");
    expect(markup).toContain("Challenge citation");
    expect(markup).not.toContain("Full document");
    expect(markup).not.toContain("page/bbox");
  });

  test("renders low-confidence, conflicting, and unavailable source states honestly", () => {
    const low = renderSourceFolioSurface({
      caveat: "Low-confidence retrieval; use this as a prompt to re-check the course source.",
      confidenceLabel: "Low confidence",
      source: { ...sourceFolio.source, confidence: "low" },
      state: "low_confidence",
    });
    const conflicting = renderSourceFolioSurface({
      caveat: "Conflicting source material: source spans disagree.",
      confidenceLabel: "Medium confidence",
      source: { ...sourceFolio.source, confidence: "medium" },
      state: "conflicting",
    });
    const unavailable = renderSourceFolioSurface({
      caveat: "No bounded source_reference has arrived for this correction.",
      confidenceLabel: "Source unavailable",
      conceptStatus: "Source status unavailable",
      source: { confidence: "low", excerpt: "", label: "Source unavailable" },
      state: "unavailable",
    });

    expect(low).toContain("Low confidence");
    expect(low).toContain("Low-confidence retrieval");
    expect(conflicting).toContain("Conflicting source material");
    expect(unavailable).toContain("Source unavailable");
    expect(unavailable).toContain("No bounded source_reference");
  });

  test("renders unavailable causes in both capsule and marginalia", () => {
    const markup = renderRuntimeSurfaces(
      projectRuntimeCopy({
        readiness: trustedReadiness,
        status: "closed",
        errors: ["WebSocket error"],
      }),
    );

    expect(markup).toContain("Agent offline");
    expect(markup).toContain("Agent unavailable: service offline.");
    expect(markup).toContain("WebSocket error");
    expect(markup).toContain("Retry agent");
  });

  test("renders quiet readiness ladder without blocking the centered plate", () => {
    const runtimeCopy = projectRuntimeCopy({
      readiness: trustedReadiness,
      readinessProbe: {
        apiBaseUrl: "http://localhost:4318",
        error: "connection refused",
        status: "offline",
      },
      status: "connecting",
    });

    const markup = renderRuntimeSurfaces(runtimeCopy);

    expect(markup).toContain('class="readiness-ladder"');
    expect(markup).toContain("/ready");
    expect(markup).toContain("/health/brain");
    expect(markup).toContain("Retry agent");
    expect(markup).not.toContain("disabled");
    expect(markup).not.toContain("modal");
  });
});

function boxesOverlap(
  a: { left: number; right: number; top: number; bottom: number },
  b: { left: number; right: number; top: number; bottom: number },
) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
