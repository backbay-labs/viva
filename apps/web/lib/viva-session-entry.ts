const SESSION_TOKEN_PARAM = "session_token";
const TOKEN_ALIAS_PARAM = "token";
const USER_ID_PARAM = "user_id";
const STUDY_SET_ID_PARAM = "study_set_id";
const SESSION_ID_PARAM = "session_id";
const TOKEN_PARAM_NAMES = [SESSION_TOKEN_PARAM, TOKEN_ALIAS_PARAM] as const;

export type SessionRouteIdentity = {
  userId: string | null;
  studySetId: string | null;
  sessionId: string | null;
  sessionToken: string | null;
};

export type LibrarySessionTargetInput = {
  userId?: string | null;
  studySetId?: string | null;
  sessionId?: string | null;
  sessionToken?: string | null;
};

export function sessionTokenFromSearch(search: string): string | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return sessionTokenFromParams(params);
}

export function sessionTokenFromHash(hash: string): string | null {
  return sessionTokenFromParams(hashParams(hash));
}

export function sessionTokenFromLocationParts(search: string, hash: string): string | null {
  return sessionTokenFromSearch(search) ?? sessionTokenFromHash(hash);
}

function sessionTokenFromParams(params: URLSearchParams): string | null {
  const token = params.get(SESSION_TOKEN_PARAM) ?? params.get(TOKEN_ALIAS_PARAM);
  const trimmed = token?.trim();
  return trimmed ? trimmed : null;
}

export function sessionRouteIdentityFromSearch(search: string): SessionRouteIdentity {
  return sessionRouteIdentityFromLocationParts(search, "");
}

export function sessionRouteIdentityFromLocationParts(
  search: string,
  hash: string,
): SessionRouteIdentity {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return {
    userId: trimmedParam(params, USER_ID_PARAM),
    studySetId: trimmedParam(params, STUDY_SET_ID_PARAM),
    sessionId: trimmedParam(params, SESSION_ID_PARAM),
    sessionToken: sessionTokenFromLocationParts(search, hash),
  };
}

export function landingSessionTarget(search = "", hash = ""): string {
  const token = sessionTokenFromLocationParts(search, hash);
  if (!token) return "/session";
  return `/session#${sessionTokenFragment(token)}`;
}

export function librarySessionTarget(input: LibrarySessionTargetInput): string {
  const params = new URLSearchParams();
  appendParam(params, USER_ID_PARAM, input.userId);
  appendParam(params, STUDY_SET_ID_PARAM, input.studySetId);
  appendParam(params, SESSION_ID_PARAM, input.sessionId);
  const query = params.toString();
  const tokenFragment = input.sessionToken?.trim()
    ? `#${sessionTokenFragment(input.sessionToken)}`
    : "";
  return `${query ? `/session?${query}` : "/session"}${tokenFragment}`;
}

export function canonicalSessionLocation(pathname: string, search: string, hash: string): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  removeTokenParams(params);
  const query = params.toString();
  return `${pathname || "/session"}${query ? `?${query}` : ""}${canonicalHash(hash)}`;
}

export function canonicalizeSessionBrowserUrl(windowLike: Pick<Window, "history" | "location">) {
  const canonical = canonicalSessionLocation(
    windowLike.location.pathname,
    windowLike.location.search,
    windowLike.location.hash,
  );
  const current = `${windowLike.location.pathname}${windowLike.location.search}${windowLike.location.hash}`;
  if (canonical !== current) {
    windowLike.history.replaceState(windowLike.history.state, "", canonical);
  }
}

function trimmedParam(params: URLSearchParams, key: string): string | null {
  const value = params.get(key)?.trim();
  return value ? value : null;
}

function appendParam(params: URLSearchParams, key: string, value: string | null | undefined) {
  const trimmed = value?.trim();
  if (trimmed) params.set(key, trimmed);
}

function sessionTokenFragment(token: string): string {
  return new URLSearchParams({ [SESSION_TOKEN_PARAM]: token.trim() }).toString();
}

function hashParams(hash: string): URLSearchParams {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw?.includes("=")) return new URLSearchParams();
  return new URLSearchParams(raw);
}

function removeTokenParams(params: URLSearchParams) {
  for (const key of TOKEN_PARAM_NAMES) params.delete(key);
}

function hasTokenParam(params: URLSearchParams): boolean {
  return TOKEN_PARAM_NAMES.some((key) => params.has(key));
}

function canonicalHash(hash: string): string {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return "";
  if (!raw.includes("=")) return hash.startsWith("#") ? hash : `#${raw}`;
  const params = new URLSearchParams(raw);
  if (!hasTokenParam(params)) return `#${params.toString()}`;
  removeTokenParams(params);
  const query = params.toString();
  return query ? `#${query}` : "";
}
