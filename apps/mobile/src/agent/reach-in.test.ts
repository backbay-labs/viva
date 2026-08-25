import { describe, expect, test } from "bun:test";
import { parseVivaServerFrame, VIVA_VOICE_PROTOCOL_VERSION } from "@viva/core";
import {
  deriveVivaAgentUiState,
  initialVivaAgentSessionState,
  vivaAgentReducer,
} from "@/agent/shared-web";

describe("shared web session modules load under the mobile toolchain", () => {
  test("reducer + derive process a ready frame and a question", () => {
    let state = initialVivaAgentSessionState();
    state = vivaAgentReducer(
      state,
      parseVivaServerFrame({
        brain: { configured: true, live_runtime: false, provider: "synthetic", selectable: true },
        input_encoding: "pcm_s16le",
        sample_rate_hz: 24000,
        store: {
          available: true,
          backend: "in_memory",
          durable: false,
          nonce_replay_protection: false,
          raw_audio_persistence: false,
          transcript_persistence: false,
          uuid_schema_translation: false,
        },
        type: "ready",
        version: VIVA_VOICE_PROTOCOL_VERSION,
      }),
    );
    expect(state.status).toBe("open");
    expect(deriveVivaAgentUiState(state).canSubmitAnswer).toBe(true);
  });
});
