const SESSION_TOKEN_PARAM = "session_token";
const TOKEN_ALIAS_PARAM = "token";
const USER_ID_PARAM = "user_id";
const STUDY_SET_ID_PARAM = "study_set_id";
const SESSION_ID_PARAM = "session_id";

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
  const token = params.get(SESSION_TOKEN_PARAM) ?? params.get(TOKEN_ALIAS_PARAM);
  const trimmed = token?.trim();
  return trimmed ? trimmed : null;
}

export function sessionRouteIdentityFromSearch(search: string): SessionRouteIdentity {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return {
    userId: trimmedParam(params, USER_ID_PARAM),
    studySetId: trimmedParam(params, STUDY_SET_ID_PARAM),
    sessionId: trimmedParam(params, SESSION_ID_PARAM),
    sessionToken: sessionTokenFromSearch(search),
  };
}

export function landingSessionTarget(search = ""): string {
  const token = sessionTokenFromSearch(search);
  if (!token) return "/session";
  const params = new URLSearchParams({ [SESSION_TOKEN_PARAM]: token });
  return `/session?${params.toString()}`;
}

export function librarySessionTarget(input: LibrarySessionTargetInput): string {
  const params = new URLSearchParams();
  appendParam(params, USER_ID_PARAM, input.userId);
  appendParam(params, STUDY_SET_ID_PARAM, input.studySetId);
  appendParam(params, SESSION_ID_PARAM, input.sessionId);
  appendParam(params, SESSION_TOKEN_PARAM, input.sessionToken);
  const query = params.toString();
  return query ? `/session?${query}` : "/session";
}

function trimmedParam(params: URLSearchParams, key: string): string | null {
  const value = params.get(key)?.trim();
  return value ? value : null;
}

function appendParam(params: URLSearchParams, key: string, value: string | null | undefined) {
  const trimmed = value?.trim();
  if (trimmed) params.set(key, trimmed);
}
