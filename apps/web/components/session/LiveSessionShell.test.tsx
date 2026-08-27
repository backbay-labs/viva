import { describe, expect, test } from "bun:test";
import {
  type AgentStudySetReadiness,
  type SessionRecap,
  VIVA_VOICE_PROTOCOL_ADVERTISEMENT,
  VIVA_VOICE_PROTOCOL_VERSION,
  type VivaReadyFrame,
} from "@viva/core";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionReviewPlanItem } from "../../lib/viva-display";
import type { VivaSceneState } from "../../lib/viva-scene-reducer";
import {
  projectRuntimeCopy,
  type RuntimeCopy,
  type SourceFolioProjection,
  type VoiceTurnTakingState,
} from "../../lib/viva-session-projection";
import { LiveSessionShell } from "./LiveSessionShell";
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
        documentId: "lec-5",
        excerpt: "Electron flow pumps protons across the inner mitochondrial membrane.",
        label: "Lecture 5 · Slide 18",
        retrievalReason: "server bounded source moment",
        span: "slide:18",
      },
      status: "strong",
      text: "Question source: oxidative phosphorylation.",
    },
  ],
  strongConcepts: ["electron donor"],
  summary: "The Conductor recap stayed grounded to the server-owned source span.",
};

const trustedReviewPlan: SessionReviewPlanItem[] = [
  {
    authority: "server_persisted_fsrs",
    conceptId: "atp-synthase",
    dueAt: "2026-06-18T12:00:00.000Z",
    intervalLabel: "tomorrow",
    label: "ATP synthase",
    status: "missed",
  },
  {
    authority: "server_persisted_fsrs",
    conceptId: "oxidative-phosphorylation",
    dueAt: "2026-06-21T12:00:00.000Z",
    intervalLabel: "in 4 days",
    label: "Oxidative phosphorylation",
    status: "shaky",
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

const serverIngestedConceptNodes = [
  ...denseConceptNodes,
  { id: "inner-membrane", label: "Inner mitochondrial membrane", status: "review", emphasis: 0.5 },
  { id: "cytochrome-c", label: "Cytochrome c", status: "shaky", emphasis: 0.7 },
  { id: "complex-iv", label: "Complex IV", status: "review", emphasis: 0.45 },
  { id: "water", label: "Water formation", status: "strong", emphasis: 0.25 },
  { id: "chemiosmosis", label: "Chemiosmosis", status: "missed", emphasis: 1 },
  { id: "adp-pi", label: "ADP + Pi", status: "review", emphasis: 0.4 },
  { id: "matrix", label: "Mitochondrial matrix", status: "shaky", emphasis: 0.8 },
  { id: "intermembrane", label: "Intermembrane space", status: "review", emphasis: 0.55 },
] as const;

const crowdedNarrowTracePoints = [
  { x: 16.594434399597592, y: 79.99488019771769 },
  { x: 57.579370436475365, y: 98.1426989220289 },
  { x: 99.43751171920508, y: 100.37326006290412 },
  { x: 140.02523209023306, y: 89.1289555460795 },
  { x: 187.9456062888585, y: 84.48651282224249 },
  { x: 224.8389659286666, y: 57.28025170529557 },
  { x: 263.28653631977994, y: 59.189731234207585 },
  { x: 305.90642473953795, y: 70.79458203296255 },
] as const;

function ready(provider: string, overrides: Partial<VivaReadyFrame["brain"]> = {}): VivaReadyFrame {
  return {
    type: "ready",
    version: VIVA_VOICE_PROTOCOL_VERSION,
    protocol: VIVA_VOICE_PROTOCOL_ADVERTISEMENT,
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
      nonce_replay_protection: true,
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

  test("surfaces the agent's re-prompt as guidance for the retry, omitting it when absent", () => {
    const guided = renderToStaticMarkup(
      <MarginaliaPanel
        hintShown={false}
        onBackToQuestion={noop}
        onHint={noop}
        onNextQuestion={noop}
        onShowSource={noop}
        onSubmitAnswer={noop}
        onTryAgain={noop}
        question={{
          ...question,
          correctionBody: "You named ATP, but skipped the mechanism.",
          retryPrompt: "Now connect that electron flow to ATP synthase in one precise sentence.",
        }}
        runtime={runtime}
        scene={scene}
        state="correction"
      />,
    );
    expect(guided).toContain("correction__retry-cue");
    expect(guided).toContain(
      "Now connect that electron flow to ATP synthase in one precise sentence.",
    );

    const bare = renderToStaticMarkup(
      <MarginaliaPanel
        hintShown={false}
        onBackToQuestion={noop}
        onHint={noop}
        onNextQuestion={noop}
        onShowSource={noop}
        onSubmitAnswer={noop}
        onTryAgain={noop}
        question={{ ...question, correctionBody: "Missed it." }}
        runtime={runtime}
        scene={scene}
        state="correction"
      />,
    );
    expect(bare).not.toContain("correction__retry-cue");
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

  test("keeps uncapped server concept labels bounded on a narrow trace", () => {
    const crowdedNodes = serverIngestedConceptNodes.slice(0, crowdedNarrowTracePoints.length);
    const labels = planVoiceTraceConceptLabels({
      canvasHeight: 172,
      canvasWidth: 320,
      fontScale: 0.72,
      items: crowdedNodes.map((node, index) => ({
        emphasis: index % 5 === 0 ? 1 : 0.55,
        label: node.label,
        point: crowdedNarrowTracePoints[index],
      })),
    });

    expect(labels).toHaveLength(crowdedNodes.length);
    expect(labels.every((label) => !label.hidden)).toBe(true);
    expect(labels.every((label) => label.text.length > 0)).toBe(true);

    for (const label of labels) {
      expect(label.box.left).toBeGreaterThanOrEqual(8);
      expect(label.box.right).toBeLessThanOrEqual(312);
      expect(label.box.top).toBeGreaterThanOrEqual(8);
      expect(label.box.bottom).toBeLessThanOrEqual(164);
    }

    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        expect(boxesOverlap(labels[i].box, labels[j].box)).toBe(false);
      }
    }
  });

  test("reserves conservative boxes for short biochemical abbreviations", () => {
    const labels = planVoiceTraceConceptLabels({
      canvasHeight: 172,
      canvasWidth: 320,
      fontScale: 0.72,
      items: [
        { emphasis: 1, label: "FADH2", point: { x: 32, y: 82 } },
        { emphasis: 0.55, label: "IMS", point: { x: 64, y: 82 } },
      ],
    });

    const fadh2Width = labels[0].box.right - labels[0].box.left;
    const imsWidth = labels[1].box.right - labels[1].box.left;

    expect(fadh2Width).toBeGreaterThanOrEqual(41);
    expect(imsWidth).toBeGreaterThanOrEqual(19);
    expect(boxesOverlap(labels[0].box, labels[1].box)).toBe(false);
    expect(labels[0].box.left).toBeGreaterThanOrEqual(8);
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

  test("exposes the active generation id as non-visible browser evidence metadata", () => {
    const markup = renderToStaticMarkup(
      <LiveSessionShell
        clockLabel="Fixture clock"
        conceptNodes={[]}
        contextLabel="Trusted server set: Biology Midterm"
        elapsed={5}
        generationId="session_bootstrap-1"
        glyphState="listening"
        highlightedTokens={[]}
        hintShown={false}
        levelRef={{ current: { agent: 0, user: 0 } }}
        onBackToQuestion={noop}
        onEndSession={noop}
        onHint={noop}
        onNextQuestion={noop}
        onShowSource={noop}
        onSubmitAnswer={noop}
        onTryAgain={noop}
        question={question}
        runtime={runtime}
        scene={scene}
        state="listening"
      />,
    );

    expect(markup).toContain('data-generation-id="session_bootstrap-1"');
  });

  test("renders voice turn state, captions, and the screen-reader live status in the plate", () => {
    const turnTaking: VoiceTurnTakingState = {
      ariaStatus: "Speaking. Viva is speaking. Feedback audio is playing.",
      captions: [
        { kind: "question", label: "Question", text: "Explain the role of NADH." },
        { kind: "feedback", label: "Feedback", text: "Connect NADH to the proton gradient." },
      ],
      detail: "Feedback audio is playing while the captions stay visible.",
      headline: "Viva is speaking.",
      interruptAcknowledged: false,
      label: "Speaking",
      phase: "speaking",
    };

    const markup = renderToStaticMarkup(
      <LiveSessionShell
        clockLabel="Fixture clock"
        conceptNodes={[]}
        contextLabel="Trusted server set: Biology Midterm"
        elapsed={5}
        glyphState="listening"
        highlightedTokens={[]}
        hintShown={false}
        levelRef={{ current: { agent: 0.6, user: 0 } }}
        onBackToQuestion={noop}
        onEndSession={noop}
        onHint={noop}
        onNextQuestion={noop}
        onShowSource={noop}
        onSubmitAnswer={noop}
        onTryAgain={noop}
        question={question}
        runtime={runtime}
        state="correction"
        turnTaking={turnTaking}
      />,
    );

    expect(markup).toContain('aria-label="Voice turn state"');
    expect(markup).toContain('data-phase="speaking"');
    expect(markup).toContain('class="turn-taking__status"');
    expect(markup).toContain('class="sr-only"');
    expect(markup).not.toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("Viva is speaking.");
    expect(markup).toContain('aria-label="Spoken captions"');
    expect(markup).toContain("Question");
    expect(markup).toContain("Feedback");
    expect(markup).toContain("Connect NADH to the proton gradient.");
  });

  test("renders no-speech and barge-in nudges as learner-safe visible states", () => {
    const noSpeech: VoiceTurnTakingState = {
      ariaStatus: "Your turn. Listening for your answer. No speech captured.",
      captions: [{ kind: "question", label: "Question", text: "Explain the role of NADH." }],
      detail: "Speak now; if nothing is captured, Viva will offer the text answer path.",
      headline: "Listening for your answer.",
      interruptAcknowledged: false,
      label: "Your turn",
      nudge: { label: "No speech captured", text: "Write the answer here or try speaking again." },
      phase: "listening",
    };
    const interrupted: VoiceTurnTakingState = {
      ...noSpeech,
      ariaStatus: "Your turn. Listening for your answer. Interruption acknowledged.",
      interruptAcknowledged: true,
      nudge: {
        label: "Interruption acknowledged",
        text: "Viva stopped speaking and is listening again.",
      },
    };

    const renderTurn = (turnTaking: VoiceTurnTakingState) =>
      renderToStaticMarkup(
        <LiveSessionShell
          clockLabel="Fixture clock"
          conceptNodes={[]}
          contextLabel="Trusted server set: Biology Midterm"
          elapsed={5}
          glyphState="listening"
          highlightedTokens={[]}
          hintShown={false}
          onBackToQuestion={noop}
          onEndSession={noop}
          onHint={noop}
          onNextQuestion={noop}
          onShowSource={noop}
          onSubmitAnswer={noop}
          onTryAgain={noop}
          question={question}
          runtime={runtime}
          state="listening"
          turnTaking={turnTaking}
        />,
      );

    const noSpeechMarkup = renderTurn(noSpeech);
    const interruptedMarkup = renderTurn(interrupted);

    expect(noSpeechMarkup).toContain("No speech captured");
    expect(noSpeechMarkup).toContain("Write the answer here");
    expect(interruptedMarkup).toContain("Interruption acknowledged");
    expect(interruptedMarkup).toContain("stopped speaking");
    expect(/raw audio|pcm16|session_token|source excerpt/i.test(noSpeechMarkup)).toBe(false);
    expect(/raw audio|pcm16|session_token|source excerpt/i.test(interruptedMarkup)).toBe(false);
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
        state="recap"
      />,
    );

    expect(markup).toContain("Recap ready");
    expect(markup).toContain("Server recap headline");
    expect(markup).toContain("The Conductor recap stayed grounded");
    expect(markup).toContain("Review later");
    expect(markup).toContain("proton gradient");
    expect(markup).toContain("Next session");
    expect(markup).toContain("ATP synthase");
    // The old hard-coded "core FSRS" label claimed an authority the browser no
    // longer computes; what renders now is the projection's own persisted
    // instant, on the runtime-local calendar.
    expect(markup).not.toContain("core FSRS");
    expect(markup).not.toContain("FSRS rating");
    expect(markup).toContain("tomorrow · Due ");
    expect(markup).toContain("2026");
    expect(markup).toContain("18");
    expect(markup).toContain("Review the ATP synthase source span");
    expect(markup).not.toContain("Share");
    expect(markup).not.toContain("Add to calendar");
    expect(markup).not.toContain("Back to question");
  });

  test("scopes the marginalia live region to a concise status announcer, not the whole panel", () => {
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
        textAnswer={{ active: true, disabled: false, required: false }}
      />,
    );

    // The panel body (readiness ladder, the answer textarea/form) is no longer a
    // live region, so the 5s readiness probe and a focused textarea aren't re-read.
    expect(markup).not.toContain('class="marginalia__body" aria-live');
    // A small visually-hidden announcer carries the concise, stable status instead.
    expect(markup).toContain("marginalia__announcer");
    expect(markup).toContain("Listening for your answer.");
  });

  test("the marginalia announcer names the recap without re-reading the closing fold", () => {
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
        state="recap"
      />,
    );

    expect(markup).toContain("marginalia__announcer");
    expect(markup).toContain("Session recap ready");
    expect(markup).toContain("Server recap headline");
  });

  test("the thinking margin weighs the answer as a whole when a question surfaces no terms", () => {
    // A valid agent question may carry zero expected_terms (the contract allows
    // it), so the checklist is empty — the margin must not claim it's
    // cross-referencing while showing nothing.
    const markup = renderToStaticMarkup(
      <MarginaliaPanel
        hintShown={false}
        onBackToQuestion={noop}
        onHint={noop}
        onNextQuestion={noop}
        onShowSource={noop}
        onSubmitAnswer={noop}
        onTryAgain={noop}
        question={{ ...question, checklist: [] }}
        runtime={runtime}
        state="thinking"
      />,
    );

    expect(markup).toContain("Weighing your answer as a whole.");
    // No empty checklist list is rendered when there are no terms.
    expect(markup).not.toContain('class="checklist"');
  });

  test("the thinking checklist carries a per-item index so its marks stagger in", () => {
    const thinkingQuestion: Question = {
      ...question,
      checklist: [
        { label: "NADH identified", status: "done" },
        { label: "Mechanism partial", status: "partial" },
        { label: "Proton gradient missing", status: "missing" },
      ],
    };

    const markup = renderToStaticMarkup(
      <MarginaliaPanel
        hintShown={false}
        onBackToQuestion={noop}
        onHint={noop}
        onNextQuestion={noop}
        onShowSource={noop}
        onSubmitAnswer={noop}
        onTryAgain={noop}
        question={thinkingQuestion}
        runtime={runtime}
        state="thinking"
      />,
    );

    expect(markup).toContain("NADH identified");
    // The CSS stagger keys off a per-item index custom property.
    expect(markup).toContain("--i:0");
    expect(markup).toContain("--i:1");
    expect(markup).toContain("--i:2");
  });

  test("the thinking margin exposes bounded progress and a distinct cancel control", () => {
    const markup = renderToStaticMarkup(
      <MarginaliaPanel
        checkingControl={{ onCancelTurn: noop }}
        hintShown={false}
        onBackToQuestion={noop}
        onHint={noop}
        onNextQuestion={noop}
        onShowSource={noop}
        onSubmitAnswer={noop}
        onTryAgain={noop}
        question={{ ...question, checklist: [] }}
        runtime={runtime}
        state="thinking"
      />,
    );

    expect(markup).toContain('aria-label="Checking progress"');
    expect(markup).toContain("Saved");
    expect(markup).toContain("Checking");
    expect(markup).toContain("Feedback");
    expect(markup).toContain("Cancel this turn");
    expect(markup).not.toContain("End session");
  });

  test("flags a low-confidence voice transcription in the student-hand echo", () => {
    const base = {
      hintShown: false,
      onBackToQuestion: noop,
      onHint: noop,
      onNextQuestion: noop,
      onShowSource: noop,
      onSubmitAnswer: noop,
      onTryAgain: noop,
      question,
      runtime,
      state: "correction" as const,
    };

    const uncertain = renderToStaticMarkup(
      <MarginaliaPanel
        {...base}
        textAnswer={{
          active: false,
          disabled: false,
          lastAnswer: "NADH donates electrons",
          lastAnswerUncertain: true,
          required: false,
        }}
      />,
    );
    expect(uncertain).toContain("Heard with some uncertainty");

    const confident = renderToStaticMarkup(
      <MarginaliaPanel
        {...base}
        textAnswer={{
          active: false,
          disabled: false,
          lastAnswer: "NADH donates electrons",
          lastAnswerUncertain: false,
          required: false,
        }}
      />,
    );
    expect(confident).not.toContain("Heard with some uncertainty");
  });

  test("renders controlled terminal copy when a terminal phase has no recap payload", () => {
    const runtimeCopy = projectRuntimeCopy({
      close: { code: 1008, reason: "session cap", wasClean: true },
      readiness: trustedReadiness,
      ready: ready("synthetic"),
      status: "closed",
      terminalReason: "session_cap",
    });

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
        runtime={runtimeCopy}
        state="recap"
      />,
    );

    expect(markup).toContain("The session cap closed this manuscript.");
    expect(markup).toContain("Start a new session");
    expect(markup).not.toContain("Conductor recap");
  });

  test("renders recap_ready as a closing fold across the center plate and margin", () => {
    const markup = renderToStaticMarkup(
      <LiveSessionShell
        clockLabel="Fixture clock"
        conceptNodes={[...denseConceptNodes]}
        contextLabel="Trusted server set: Biology Midterm"
        elapsed={620}
        glyphState="idle"
        highlightedTokens={["NADH", "ATP synthase"]}
        hintShown={false}
        onBackToQuestion={noop}
        onEndSession={noop}
        onHint={noop}
        onNextQuestion={noop}
        onShowSource={noop}
        onSubmitAnswer={noop}
        onTryAgain={noop}
        question={{
          ...question,
          explanation: trustedRecap.summary,
          prompt: "Good session,\nAnanya.",
          sourceRef: "Lecture 5 · Slide 18",
        }}
        recap={trustedRecap}
        reviewPlan={trustedReviewPlan}
        runtime={runtime}
        state="recap"
      />,
    );

    expect(markup).toContain("Good session");
    expect(markup).toContain("The manuscript is folded for review.");
    expect(markup).toContain("Closing fold");
    expect(markup).toContain("Server recap headline");
    expect(markup).toContain("Source moments");
    expect(markup).toContain("Lecture 5 · Slide 18");
    expect(markup).toContain("Confidence");
    expect(markup).toContain("High confidence");
    expect(markup).toContain("Span");
    expect(markup).toContain("lec-5");
    expect(markup).toContain("slide:18");
    expect(markup).toContain("Electron flow pumps protons");
    expect(markup).toContain("Due Jun 18, 2026");
    // The old hard-coded "core FSRS" label claimed an authority the browser no
    // longer computes; what renders now is the projection's own persisted
    // instant, on the runtime-local calendar.
    expect(markup).not.toContain("core FSRS");
    expect(markup).not.toContain("FSRS rating");
    expect(markup).toContain("tomorrow · Due ");
    expect(markup).toContain("2026");
    expect(markup).toContain("18");
    expect(markup).toContain('class="voice-trace"');
    expect(markup).not.toContain("Use this to answer again.");
    expect(markup).not.toContain("dashboard");
  });

  test("recap closing fold renders mastery rings and the study-plan timeline", () => {
    const richRecap: SessionRecap = {
      ...trustedRecap,
      missedConcepts: ["chemiosmosis"],
      plan: [
        { day: "Today", meta: "Completed", status: "done", topics: "Cellular respiration" },
        { day: "Tomorrow · 15 min", meta: "Scheduled", status: "today", topics: "Proton gradient" },
        { day: "Fri · 15 min", meta: "Pre-exam", status: "upcoming", topics: "ATP synthase" },
      ],
      reviewLater: ["ATP synthase"],
      shakyConcepts: ["proton gradient"],
      strongConcepts: ["electron donor", "redox pair"],
    };

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
        recap={richRecap}
        reviewPlan={trustedReviewPlan}
        runtime={runtime}
        state="recap"
      />,
    );

    // Three mastery rings summarise the session shape at a glance.
    expect((markup.match(/class="mastery-ring"/g) ?? []).length).toBe(3);
    // strong 2 / shaky (1 shaky + 1 missed) / review 1 -> 5 graded -> 40% / 40% / 20%.
    expect(markup).toContain("recap-stat");
    expect(markup).toContain("2 concepts");
    expect(markup).toContain("1 concept<");
    // The ring percentages are each tier's honest share of the graded concepts.
    expect(markup).toContain(">40</span>%");
    expect(markup).toContain(">20</span>%");
    // The generated study plan renders as a real timeline, not comma-joined text.
    expect((markup.match(/class="timeline-item /g) ?? []).length).toBe(3);
    expect(markup).toContain("Study plan");
    expect(markup).toContain("Cellular respiration");
    expect(markup).toContain("Pre-exam");
    // The precise FSRS-dated next session is preserved alongside the timeline.
    expect(markup).toContain("Next session");
    // The old hard-coded "core FSRS" label claimed an authority the browser no
    // longer computes; what renders now is the projection's own persisted
    // instant, on the runtime-local calendar.
    expect(markup).not.toContain("core FSRS");
    expect(markup).not.toContain("FSRS rating");
    expect(markup).toContain("tomorrow · Due ");
    expect(markup).toContain("2026");
    expect(markup).toContain("18");
  });

  test("recap closing fold omits the mastery rings when no concepts were graded", () => {
    const emptyRecap: SessionRecap = {
      ...trustedRecap,
      missedConcepts: [],
      reviewLater: [],
      shakyConcepts: [],
      strongConcepts: [],
    };

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
        recap={emptyRecap}
        reviewPlan={[]}
        runtime={runtime}
        state="recap"
      />,
    );

    expect(markup).not.toContain("mastery-ring");
    expect(markup).toContain("Closing fold");
  });

  test("renders recording disclosure before microphone capture is acknowledged", () => {
    const markup = renderToStaticMarkup(
      <LiveSessionShell
        clockLabel="Fixture clock"
        conceptNodes={[...denseConceptNodes]}
        consentDisclosure={{ acknowledged: false, onAcknowledge: noop }}
        contextLabel="Trusted server set: Biology Midterm"
        elapsed={12}
        glyphState="idle"
        highlightedTokens={["NADH"]}
        hintShown={false}
        onBackToQuestion={noop}
        onEndSession={noop}
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

    expect(markup).toContain("Recording disclosure");
    expect(markup).toContain("Cartesia Ink/Sonic and Google Gemini");
    expect(markup).toContain("Acknowledge");
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
    // The folio is a focus landing target so opening it moves keyboard focus
    // here instead of dropping it to <body>.
    expect(/<section[^>]*class="folio source-folio"[^>]*tabindex="-1"/.test(markup)).toBe(true);
    expect(markup).toContain('aria-label="Source folio"');
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
