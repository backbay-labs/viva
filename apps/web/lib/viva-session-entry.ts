const SESSION_TOKEN_PARAM = "session_token";
const TOKEN_ALIAS_PARAM = "token";

export function sessionTokenFromSearch(search: string): string | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const token = params.get(SESSION_TOKEN_PARAM) ?? params.get(TOKEN_ALIAS_PARAM);
  const trimmed = token?.trim();
  return trimmed ? trimmed : null;
}

export function landingSessionTarget(search = ""): string {
  const token = sessionTokenFromSearch(search);
  if (!token) return "/session";
  const params = new URLSearchParams({ [SESSION_TOKEN_PARAM]: token });
  return `/session?${params.toString()}`;
}
