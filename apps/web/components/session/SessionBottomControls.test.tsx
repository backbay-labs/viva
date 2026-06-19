import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionBottomControls } from "./SessionBottomControls";

describe("SessionBottomControls", () => {
  test("end session delegates to the agent stop path instead of routing away", () => {
    const calls: string[] = [];
    const element = SessionBottomControls({
      onEndSession: () => calls.push("stop"),
    }) as ReactElement<{ children: ReactElement[] }>;
    const [endButton] = element.props.children as Array<ReactElement<{ onClick: () => void }>>;

    endButton.props.onClick();

    expect(calls).toEqual(["stop"]);
  });

  test("the sources control reveals the source folio instead of doing nothing", () => {
    const calls: string[] = [];
    const element = SessionBottomControls({
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
        onEndSession={() => {}}
        transcript="NADH donates electrons to the electron transport chain."
      />,
    );

    expect(markup).toContain("<details");
    expect(markup).toContain("Transcript");
    expect(markup).toContain("NADH donates electrons to the electron transport chain.");
  });

  test("the transcript control shows an honest empty state before any turn is finalized", () => {
    const markup = renderToStaticMarkup(<SessionBottomControls onEndSession={() => {}} />);

    expect(markup).toContain("session-controls__empty");
    expect(markup).not.toContain("NADH donates electrons");
  });
});
