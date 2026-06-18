import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
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
});
