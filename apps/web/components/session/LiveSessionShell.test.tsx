import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { VivaSceneState } from "../../lib/viva-scene-reducer";
import { MarginaliaPanel } from "./MarginaliaPanel";
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
});
