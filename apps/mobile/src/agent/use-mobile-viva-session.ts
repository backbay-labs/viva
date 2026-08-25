import {
  type AgentSessionConfig,
  agentStudySetReadiness,
  type StudyMode,
  type StudySet,
} from "@viva/core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppStateStatus } from "react-native";

import { sessionResultStore } from "@/agent/session-store";
import {
  createVivaAgentSessionController,
  deriveVivaAgentUiState,
  initialVivaAgentSessionState,
  studySetToAgentSessionConfig,
  type VivaAgentAudioOutput,
  type VivaAgentGenerationReason,
  type VivaAgentSessionController,
  type VivaAgentSessionState,
} from "@/agent/shared-web";
import { createMobileCaptureSession, type MobileCaptureSession } from "@/audio/capture";
import { createMobilePlaybackSession, type MobilePlaybackSession } from "@/audio/playback";
import { type AppConfig, loadAppConfig } from "@/runtime/config";

const ALLOWED_MOBILE_FRAME_TYPES = new Set(["session_config", "text", "cancel", "stop"]);

type NativeWebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
  options?: { headers?: Record<string, string> },
) => WebSocket;

type AppStatePort = {
  addEventListener: (
    type: "change",
    listener: (state: AppStateStatus) => void,
  ) => { remove: () => void };
};

export type MobileVivaSessionController = Omit<VivaAgentSessionController, "sendAudio">;

export type UseMobileVivaSessionOptions = {
  config?: AppConfig;
  mode: StudyMode;
  studySet: StudySet;
};

function assertTypedMobileFrame(data: unknown): asserts data is string {
  if (typeof data !== "string") {
    throw new TypeError("Viva mobile rejects binary WebSocket payloads");
  }

  let frame: unknown;
  try {
    frame = JSON.parse(data);
  } catch {
    throw new TypeError("Viva mobile rejects malformed WebSocket payloads");
  }
  if (
    typeof frame !== "object" ||
    frame === null ||
    !("type" in frame) ||
    typeof frame.type !== "string" ||
    !ALLOWED_MOBILE_FRAME_TYPES.has(frame.type)
  ) {
    throw new TypeError("Viva mobile rejects non-typed protocol frames");
  }
}

/**
 * Wrap every mobile socket, including injected test implementations. The
 * shared v4 controller still has a legacy audio method internally; this guard
 * turns the Stage-0 typed-only policy into a runtime invariant.
 */
export function createGuardedWebSocketImplementation(
  WebSocketImpl: typeof WebSocket,
  wsOrigin: string | null,
): typeof WebSocket {
  const NativeWebSocket = WebSocketImpl as unknown as NativeWebSocketConstructor;

  class GuardedMobileWebSocket {
    readonly #native: WebSocket;

    constructor(url: string, protocols?: string | string[]) {
      this.#native = wsOrigin
        ? new NativeWebSocket(url, protocols, { headers: { Origin: wsOrigin } })
        : new NativeWebSocket(url, protocols);
    }

    get binaryType(): BinaryType {
      return this.#native.binaryType;
    }

    set binaryType(value: BinaryType) {
      this.#native.binaryType = value;
    }

    get bufferedAmount(): number {
      return this.#native.bufferedAmount;
    }

    get extensions(): string {
      return this.#native.extensions;
    }

    get protocol(): string {
      return this.#native.protocol;
    }

    get readyState(): number {
      return this.#native.readyState;
    }

    get url(): string {
      return this.#native.url;
    }

    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void {
      this.#native.addEventListener(type, listener, options);
    }

    close(code?: number, reason?: string): void {
      this.#native.close(code, reason);
    }

    dispatchEvent(event: Event): boolean {
      return this.#native.dispatchEvent(event);
    }

    removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ): void {
      this.#native.removeEventListener(type, listener, options);
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      assertTypedMobileFrame(data);
      this.#native.send(data);
    }
  }

  return GuardedMobileWebSocket as unknown as typeof WebSocket;
}

export function createMobileSessionController(options: {
  config: AppConfig;
  session: AgentSessionConfig;
  WebSocketImpl?: typeof WebSocket;
}): MobileVivaSessionController {
  const WebSocketImpl = createGuardedWebSocketImplementation(
    options.WebSocketImpl ?? WebSocket,
    options.config.wsOrigin,
  );
  const controller = createVivaAgentSessionController({
    WebSocketImpl,
    session: options.session,
    sessionToken: options.config.sessionToken,
    token: options.config.sessionToken ?? undefined,
    url: options.config.agentWsUrl,
  });
  const { sendAudio: _forbiddenAudioCapability, ...typedController } = controller;
  return typedController;
}

export function foregroundReconnectAction(input: {
  hasRecap: boolean;
  status: VivaAgentSessionState["status"];
}): "none" | "reconnect" {
  if (input.hasRecap) return "none";
  return input.status === "open" || input.status === "connecting" ? "none" : "reconnect";
}

export function applyMobileAppStateChange(input: {
  capture: Pick<MobileCaptureSession, "cancel" | "reset">;
  controller: Pick<MobileVivaSessionController, "close" | "refreshSession">;
  hasRecap: boolean;
  nextState: AppStateStatus;
  playback: Pick<MobilePlaybackSession, "resetForGeneration">;
  status: VivaAgentSessionState["status"];
}): "backgrounded" | "none" | "reconnected" {
  if (input.nextState === "background" || input.nextState === "inactive") {
    input.controller.close();
    void input.capture.cancel();
    input.playback.resetForGeneration();
    return "backgrounded";
  }
  if (
    input.nextState === "active" &&
    foregroundReconnectAction({ hasRecap: input.hasRecap, status: input.status }) === "reconnect"
  ) {
    void input.capture.reset();
    input.playback.resetForGeneration();
    input.controller.refreshSession({ reason: "socket_retry" });
    return "reconnected";
  }
  return "none";
}

function nativeAppState(): AppStatePort {
  // Bun cannot evaluate react-native's Flow entrypoint. Keep the runtime import
  // inside the hook path so pure controller and lifecycle tests stay portable.
  return (require("react-native") as { AppState: AppStatePort }).AppState;
}

export function useMobileVivaSession(options: UseMobileVivaSessionOptions) {
  const config = useMemo(() => options.config ?? loadAppConfig(), [options.config]);
  const session = useMemo(
    () =>
      studySetToAgentSessionConfig(options.studySet, {
        mode: options.mode,
        userId: config.userId,
      }),
    [config.userId, options.mode, options.studySet],
  );
  const capture = useMemo<MobileCaptureSession>(() => createMobileCaptureSession(), []);
  const playback = useMemo<MobilePlaybackSession>(() => createMobilePlaybackSession(), []);
  const controllerRef = useRef<MobileVivaSessionController | null>(null);
  const [agentState, setAgentState] = useState<VivaAgentSessionState>(initialVivaAgentSessionState);
  const derived = useMemo(() => deriveVivaAgentUiState(agentState), [agentState]);
  const latestLifecycle = useRef({ hasRecap: false, status: agentState.status });
  latestLifecycle.current = { hasRecap: Boolean(derived.recap), status: agentState.status };

  useEffect(() => {
    const controller = createMobileSessionController({ config, session });
    controllerRef.current = controller;
    setAgentState(controller.getState());
    const unsubscribe = controller.subscribe(setAgentState);
    const connectTimer = setTimeout(() => controller.connect(), 0);

    return () => {
      clearTimeout(connectTimer);
      unsubscribe();
      controller.close();
      void capture.teardown();
      playback.resetForGeneration();
      void playback.close();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [capture, config, playback, session]);

  useEffect(() => {
    const subscription = nativeAppState().addEventListener("change", (nextState) => {
      const controller = controllerRef.current;
      if (!controller) return;
      applyMobileAppStateChange({
        capture,
        controller,
        ...latestLifecycle.current,
        nextState,
        playback,
      });
    });
    return () => subscription.remove();
  }, [capture, playback]);

  useEffect(() => {
    if (!derived.recap) return;
    sessionResultStore.set({
      conceptStatuses: derived.conceptStatuses,
      recap: derived.recap,
      studySet: options.studySet,
      studySetTitle: options.studySet.title,
    });
  }, [derived.conceptStatuses, derived.recap, options.studySet]);

  const readiness = useMemo(
    () => agentStudySetReadiness(options.studySet, config.studySetId),
    [config.studySetId, options.studySet],
  );

  return {
    acknowledgeAudio: (consumed: readonly VivaAgentAudioOutput[]) =>
      controllerRef.current?.acknowledgeAudio(consumed),
    agentState,
    cancel: () => {
      void capture.cancel();
      controllerRef.current?.cancel();
    },
    capture,
    close: () => {
      void capture.teardown();
      playback.resetForGeneration();
      controllerRef.current?.close();
    },
    connect: (reason?: VivaAgentGenerationReason) => controllerRef.current?.connect(reason),
    derived,
    playback,
    readiness,
    refreshSession: (input?: {
      reason?: VivaAgentGenerationReason;
      sessionToken?: string | null;
    }) => {
      void capture.reset();
      playback.resetForGeneration();
      return controllerRef.current?.refreshSession(input);
    },
    reset: () => {
      sessionResultStore.clear();
      void capture.reset();
      playback.resetForGeneration();
      controllerRef.current?.reset();
    },
    sendText: (text: string) => controllerRef.current?.sendText(text) ?? false,
    status: agentState.status,
    stop: () => {
      void capture.stop();
      controllerRef.current?.stop();
    },
  };
}
