import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionBottomControls } from "./SessionBottomControls";

const TRANSCRIPT_ID = "live-session-transcript";

const disclosure = {
  onTranscriptOpenChange: () => {},
  transcriptId: TRANSCRIPT_ID,
  transcriptOpen: false,
};

describe("SessionBottomControls", () => {
  test("end session delegates to the agent stop path instead of routing away", () => {
    const calls: string[] = [];
    const element = SessionBottomControls({
      ...disclosure,
      onEndSession: () => calls.push("stop"),
    }) as ReactElement<{ children: ReactElement[] }>;
    const [endButton] = element.props.children as Array<ReactElement<{ onClick: () => void }>>;

    endButton.props.onClick();

    expect(calls).toEqual(["stop"]);
  });

  test("the sources control reveals the source folio instead of doing nothing", () => {
    const calls: string[] = [];
    const element = SessionBottomControls({
      ...disclosure,
      onEndSession: () => {},
      onShowSources: () => calls.push("sources"),
    }) as ReactElement<{ children: ReactElement[] }>;
    const sourcesButton = (element.props.children as Array<ReactElement<{ onClick?: () => void }>>)
      .filter((child) => child?.type === "button")
      .at(-1) as ReactElement<{ onClick: () => void }>;

    sourcesButton.props.onClick();

    expect(calls).toEqual(["sources"]);
  });

  test("the transcript control discloses the finalized transcript record", () => {
    const markup = renderToStaticMarkup(
      <SessionBottomControls
        {...disclosure}
        onEndSession={() => {}}
        transcript="NADH donates electrons to the electron transport chain."
        transcriptOpen={true}
      />,
    );

    expect(markup).toContain("Hide transcript");
    expect(markup).toContain("NADH donates electrons to the electron transport chain.");
  });

  test("the transcript control shows an honest empty state before any turn is finalized", () => {
    const markup = renderToStaticMarkup(
      <SessionBottomControls {...disclosure} onEndSession={() => {}} transcriptOpen={true} />,
    );

    expect(markup).toContain("session-controls__empty");
    expect(markup).not.toContain("NADH donates electrons");
  });
});

/**
 * `WEBSESSION-A11Y-01` — the transcript is an EXPLICIT disclosure.
 *
 * A native `<details>` announces "Transcript" with no expanded state, no
 * relationship to the region it controls, and no name that says what activating
 * it will do. A learner using a screen reader cannot tell whether the transcript
 * of their own oral exam is currently on screen.
 */
describe("transcript disclosure accessibility (WEBSESSION-A11Y-01)", () => {
  function render(overrides: Parameters<typeof SessionBottomControls>[0]) {
    return renderToStaticMarkup(<SessionBottomControls {...overrides} />);
  }

  test("closed: a named button owns the state and the relationship", () => {
    const markup = render({
      ...disclosure,
      onEndSession: () => {},
      transcript: "NADH donates electrons.",
    });

    expect(markup).toContain("Show transcript");
    expect(markup).not.toContain("Hide transcript");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain(`aria-controls="${TRANSCRIPT_ID}"`);
    expect(markup).toContain(`id="${TRANSCRIPT_ID}"`);
    // The region exists and is hidden, so the relationship the button names is
    // real rather than a promise about markup that is not there yet.
    expect(markup).toContain("hidden");
    // No ambiguous native disclosure remains.
    expect(markup).not.toContain("<details");
    expect(markup).not.toContain("<summary");
  });

  test("open: the same button and the same region, with the state flipped", () => {
    const markup = render({
      ...disclosure,
      onEndSession: () => {},
      transcript: "NADH donates electrons.",
      transcriptOpen: true,
    });

    expect(markup).toContain("Hide transcript");
    expect(markup).not.toContain("Show transcript");
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain(`aria-controls="${TRANSCRIPT_ID}"`);
    expect(markup).toContain("NADH donates electrons.");
  });

  test("an empty transcript disables the control instead of opening an empty region", () => {
    const markup = render({ ...disclosure, onEndSession: () => {} });

    // The assertion is on the TRANSCRIPT control itself: the rail's Sources
    // button is disabled here too, so a bare "contains disabled" would pass on
    // an enabled transcript toggle.
    const toggle = /<button[^>]*aria-controls="live-session-transcript"[^>]*>/.exec(markup)?.[0];
    expect(toggle).toContain("disabled");
    expect(toggle).toContain('aria-expanded="false"');
    expect(markup).toContain("Show transcript");

    const withTranscript = /<button[^>]*aria-controls="live-session-transcript"[^>]*>/.exec(
      render({ ...disclosure, onEndSession: () => {}, transcript: "A finalized turn." }),
    )?.[0];
    expect(withTranscript).not.toContain("disabled");
  });

  test("activating the control asks its owner to change state; it keeps none itself", () => {
    const changes: boolean[] = [];
    const element = SessionBottomControls({
      ...disclosure,
      onEndSession: () => {},
      onTranscriptOpenChange: (open) => changes.push(open),
      transcript: "NADH donates electrons.",
    }) as ReactElement<{ children: ReactElement[] }>;
    const toggle = (element.props.children as Array<ReactElement<{ "aria-controls"?: string }>>)
      .flatMap((child) => (child?.type === "button" ? [child] : []))
      .find((child) => child.props["aria-controls"] === TRANSCRIPT_ID) as ReactElement<{
      onClick: () => void;
    }>;

    toggle.props.onClick();

    expect(changes).toEqual([true]);
  });
});
