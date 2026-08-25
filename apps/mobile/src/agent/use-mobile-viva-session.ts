import {
  type AgentSessionConfig,
  type AgentTerminalSessionReason,
  agentStudySetReadiness,
  type StudyMode,
  type StudySet,
  VIVA_AGENT_TERMINAL_SESSION_REASONS,
} from "@viva/core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppStateStatus } from "react-native";

import { sessionResultStore } from "@/agent/session-store";
import {
  createVivaAgentSessionController,
  deriveVivaAgentUiState,
  initialVivaAgentSessionState,
  parseVivaAgentMessage,
  studySetToAgentSessionConfig,
  type VivaAgentAudioOutput,
  type VivaAgentGenerationReason,
  type VivaAgentSessionController,
  type VivaAgentSessionState,
  type VivaAudioCaptureEndReason,
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

export type MobileCaptureIssue =
  | { kind: "ended"; reason: VivaAudioCaptureEndReason; sequence: number }
  | { kind: "error"; message: string; sequence: number };

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
  onRecapPartialReason?: (reason: AgentTerminalSessionReason) => void,
): typeof WebSocket {
  const NativeWebSocket = WebSocketImpl as unknown as NativeWebSocketConstructor;

  class GuardedMobileWebSocket {
    readonly #native: WebSocket;
    readonly #partialReasonListener?: EventListener;

    constructor(url: string, protocols?: string | string[]) {
      this.#native = wsOrigin
        ? new NativeWebSocket(url, protocols, { headers: { Origin: wsOrigin } })
        : new NativeWebSocket(url, protocols);
      this.#partialReasonListener = (event) => {
        const reason = recapPartialReasonFromMessage((event as MessageEvent).data);
        if (reason) onRecapPartialReason?.(reason);
      };
      this.#native.addEventListener("message", this.#partialReasonListener);
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
      if (this.#partialReasonListener) {
        this.#native.removeEventListener?.("message", this.#partialReasonListener);
      }
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
  onRecapPartialReason?: (reason: AgentTerminalSessionReason) => void;
  session: AgentSessionConfig;
  sessionToken?: string | null;
  WebSocketImpl?: typeof WebSocket;
}): MobileVivaSessionController {
  const WebSocketImpl = createGuardedWebSocketImplementation(
    options.WebSocketImpl ?? WebSocket,
    options.config.wsOrigin,
    options.onRecapPartialReason,
  );
  const controller = createVivaAgentSessionController({
    WebSocketImpl,
    session: options.session,
    sessionToken: options.sessionToken ?? options.config.sessionToken,
    token: options.sessionToken ?? options.config.sessionToken ?? undefined,
    url: options.config.agentWsUrl,
  });
  const { sendAudio: _forbiddenAudioCapability, ...typedController } = controller;
  return typedController;
}

function recapPartialReasonFromMessage(data: unknown): AgentTerminalSessionReason | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const frame = parseVivaAgentMessage(data);
    if (frame.type !== "event" || frame.event.type !== "recap_ready") return undefined;
    const reason = frame.event.partial_reason;
    if (
      typeof reason === "string" &&
      (VIVA_AGENT_TERMINAL_SESSION_REASONS as readonly string[]).includes(reason)
    ) {
      return reason as AgentTerminalSessionReason;
    }
  } catch {
    // The shared controller owns inbound validation and diagnostics. This tap
    // only preserves one field that its current state projection drops.
  }
  return undefined;
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
  const [speaking, setSpeaking] = useState(false);
  const [recapPartialReason, setRecapPartialReason] = useState<AgentTerminalSessionReason>();
  const [captureIssue, setCaptureIssue] = useState<MobileCaptureIssue>();
  const captureIssueSequence = useRef(0);
  const captureCallbacksActive = useRef(true);
  const capture = useMemo<MobileCaptureSession>(
    () =>
      createMobileCaptureSession({
        onEnded: (reason) => {
          if (!captureCallbacksActive.current) return;
          captureIssueSequence.current += 1;
          setCaptureIssue({ kind: "ended", reason, sequence: captureIssueSequence.current });
        },
        onError: (error) => {
          if (!captureCallbacksActive.current) return;
          captureIssueSequence.current += 1;
          setCaptureIssue({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
            sequence: captureIssueSequence.current,
          });
        },
      }),
    [],
  );
  const playback = useMemo<MobilePlaybackSession>(
    () => createMobilePlaybackSession({ onSpeakingChange: setSpeaking }),
    [],
  );
  const controllerRef = useRef<MobileVivaSessionController | null>(null);
  const [agentState, setAgentState] = useState<VivaAgentSessionState>(initialVivaAgentSessionState);
  const derived = useMemo(() => deriveVivaAgentUiState(agentState), [agentState]);
  const latestLifecycle = useRef({ hasRecap: false, status: agentState.status });
  latestLifecycle.current = { hasRecap: Boolean(derived.recap), status: agentState.status };

  useEffect(() => {
    captureCallbacksActive.current = true;
    return () => {
      captureCallbacksActive.current = false;
    };
  }, []);

  useEffect(() => {
    sessionResultStore.clear();
    setCaptureIssue(undefined);
    setRecapPartialReason(undefined);
    const controller = createMobileSessionController({
      config,
      onRecapPartialReason: setRecapPartialReason,
      session,
      sessionToken: config.sessionToken ?? options.studySet.sessionToken,
    });
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
  }, [capture, config, options.studySet.sessionToken, playback, session]);

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
    if (!derived.recap && !derived.terminalReason) return;
    sessionResultStore.set({
      conceptStatuses: derived.conceptStatuses,
      partialReason: recapPartialReason,
      recap: derived.recap,
      studySet: options.studySet,
      studySetTitle: options.studySet.title,
      terminalReason: derived.terminalReason,
    });
  }, [
    derived.conceptStatuses,
    derived.recap,
    derived.terminalReason,
    options.studySet,
    recapPartialReason,
  ]);

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
    captureIssue,
    clearCaptureIssue: () => setCaptureIssue(undefined),
    close: () => {
      void capture.teardown();
      playback.resetForGeneration();
      controllerRef.current?.close();
    },
    connect: (reason?: VivaAgentGenerationReason) => {
      setCaptureIssue(undefined);
      setRecapPartialReason(undefined);
      return controllerRef.current?.connect(reason);
    },
    derived,
    playback,
    readiness,
    refreshSession: (input?: {
      reason?: VivaAgentGenerationReason;
      sessionToken?: string | null;
    }) => {
      setCaptureIssue(undefined);
      setRecapPartialReason(undefined);
      void capture.reset();
      playback.resetForGeneration();
      return controllerRef.current?.refreshSession(input);
    },
    reset: () => {
      setCaptureIssue(undefined);
      setRecapPartialReason(undefined);
      sessionResultStore.clear();
      void capture.reset();
      playback.resetForGeneration();
      controllerRef.current?.reset();
    },
    sendText: (text: string) => controllerRef.current?.sendText(text) ?? false,
    speaking,
    status: agentState.status,
    stop: () => {
      void capture.stop();
      controllerRef.current?.stop();
    },
  };
}
