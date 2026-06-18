export type SessionRestartAction =
  | "local_listening"
  | "connected_reconnect"
  | "connected_unavailable";

export function sessionRestartAction({
  connectedMode,
  canStartConnectedAgent,
}: {
  connectedMode: boolean;
  canStartConnectedAgent: boolean;
}): SessionRestartAction {
  if (!connectedMode) return "local_listening";
  return canStartConnectedAgent ? "connected_reconnect" : "connected_unavailable";
}
