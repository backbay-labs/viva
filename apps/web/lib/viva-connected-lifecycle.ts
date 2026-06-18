import type { VivaAgentSessionState } from "./viva-agent-client";

export type VivaConnectedLifecycleState =
  | "waiting_prompt"
  | "answering"
  | "waiting_feedback"
  | "correction"
  | "stopping"
  | "recap"
  | "ended_without_recap"
  | "disconnected"
  | "reconnecting";

export type VivaConnectedLifecycleInput = {
  connectedRuntime: boolean;
  stopRequested: boolean;
  state: VivaAgentSessionState;
};

export function deriveVivaConnectedLifecycle({
  connectedRuntime,
  stopRequested,
  state,
}: VivaConnectedLifecycleInput): VivaConnectedLifecycleState {
  if (!connectedRuntime) return "disconnected";
  if (state.status === "connecting") return "reconnecting";
  if (state.recap || state.phase === "recap") return "recap";
  if (stopRequested) {
    if (state.status === "closed" || state.status === "error") return "ended_without_recap";
    return "stopping";
  }
  if (state.status === "closed" || state.status === "error") return "disconnected";
  if (!state.question) return "waiting_prompt";
  if (state.phase === "correction") return "correction";
  if (state.phase === "thinking" || state.phase === "feedback") return "waiting_feedback";
  return "answering";
}

export function connectedLifecycleStatusLabel(state: VivaConnectedLifecycleState): string {
  switch (state) {
    case "waiting_prompt":
      return "waiting for prompt";
    case "answering":
      return "answering";
    case "waiting_feedback":
      return "waiting for feedback";
    case "correction":
      return "correction";
    case "stopping":
      return "stopping";
    case "recap":
      return "recap";
    case "ended_without_recap":
      return "ended without recap";
    case "reconnecting":
      return "reconnecting";
    case "disconnected":
      return "disconnected";
  }
}
