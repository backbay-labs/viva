import { describe, expect, test } from "bun:test";
import {
  type AgentStudySetReadiness,
  VIVA_VOICE_PROTOCOL_VERSION,
  type VivaReadyFrame,
} from "@viva/core";
import { renderToStaticMarkup } from "react-dom/server";
import type { VivaSceneState } from "../../lib/viva-scene-reducer";
import { projectRuntimeCopy, type RuntimeCopy } from "../../lib/viva-session-projection";
import { MarginaliaPanel } from "./MarginaliaPanel";
import { SessionHeader } from "./SessionHeader";
import type { Question } from "./session-data";
import { VoiceTraceCanvas } from "./VoiceTraceCanvas";

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
  statusLabel: "synthetic",
  cause: "synthetic",
};

const trustedReadiness: AgentStudySetReadiness = {
  canConnect: true,
  reason: "trusted",
  message: "Connected agent is mapped to a trusted server study set.",
};

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
      <SessionHeader elapsed={5} runtime={runtimeCopy} />
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

describe("LiveSessionShell scene intent wiring", () => {
  test("renders scene state onto the existing Canvas and marginalia surfaces", () => {
    const canvasMarkup = renderToStaticMarkup(
      <VoiceTraceCanvas conceptNodes={[]} scene={scene} state="correction" />,
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
    expect(marginaliaMarkup).toContain('class="marginalia"');
    expect(marginaliaMarkup).toContain('data-scene-register="correcting"');
    expect(marginaliaMarkup).toContain('data-scene-marginalia-count="1"');
    expect(`${canvasMarkup}${marginaliaMarkup}`).not.toContain("Render instruction");
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
    expect(markup).not.toContain("Live Cartesia/Gemini tutor is listening.");
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
  });
});
