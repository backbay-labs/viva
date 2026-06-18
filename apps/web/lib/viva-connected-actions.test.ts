import { describe, expect, test } from "bun:test";
import { sessionRestartAction } from "./viva-connected-actions";

describe("Viva connected session actions", () => {
  test("keeps local retries local", () => {
    expect(
      sessionRestartAction({
        connectedMode: false,
        canStartConnectedAgent: false,
      }),
    ).toBe("local_listening");
  });

  test("reconnects trusted connected retries and another drills", () => {
    expect(
      sessionRestartAction({
        connectedMode: true,
        canStartConnectedAgent: true,
      }),
    ).toBe("connected_reconnect");
  });

  test("falls back honestly when a connected restart is no longer trusted", () => {
    expect(
      sessionRestartAction({
        connectedMode: true,
        canStartConnectedAgent: false,
      }),
    ).toBe("connected_unavailable");
  });
});
