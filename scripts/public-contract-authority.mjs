/**
 * `INTEGRATION-007` follow-up — ledger row 689 (Security component `R5`).
 *
 * Which library and session operations a deployment can run, as a function of
 * what it configures, and how the service refuses when a required value is
 * absent. The reviewed gap was that `docs/deployment-runbook.md` described the
 * credentials without ever saying which operation each one makes available; this
 * module derives that from the shipped service and checks the runbook's
 * configuration matrix against the derivation.
 *
 * It is a sibling of `scripts/public-contract.mjs` for the reason `A-39.3`
 * ratified for the integration-readiness namespace: the machinery lands beside
 * the entrypoint so both stay under the unbudgeted module-concentration ceiling
 * with no policy edit.
 */

/**
 * The runbook section that carries the matrix. Its claims are checked against
 * the shipped gate, never against each other.
 */
export const LIBRARY_MATRIX_HEADING = "## Configuration Matrix";

/**
 * The balanced braced block that follows `anchor`.
 *
 * The availability rules below are about which fields ONE gate reads, and a
 * whole-file scan cannot tell one function from its neighbour. This is the
 * smallest reader that can: it needs no Rust parser and it cannot silently widen
 * to the rest of the module.
 */
function rustBlockAfter(source, anchor) {
  const start = source.indexOf(anchor);
  if (start < 0) return null;
  const open = source.indexOf("{", start + anchor.length - 1);
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return null;
}

/**
 * `environment key -> configuration field`, exactly as `from_env_with` binds it.
 *
 * Read one statement at a time so a neighbouring assignment can never be
 * credited to the wrong key, and fail generation rather than guess: an unread
 * binding would silently turn every availability claim below into prose.
 */
function configuredCredentialFields(rustConfig, keys) {
  const bindings = new Map();
  for (const statement of rustConfig.split(";")) {
    const assigned = [...statement.matchAll(/config\.(?:\w+\.)?(\w+)\s*=[^=]/g)].map(
      (entry) => entry[1],
    );
    const named = [...statement.matchAll(/env_value\("(VIVA_[A-Z_]+)"\)/g)].map(
      (entry) => entry[1],
    );
    if (assigned.length !== 1 || named.length !== 1) continue;
    if (!bindings.has(named[0])) bindings.set(named[0], assigned[0]);
  }
  const unread = keys.filter((key) => !bindings.has(key));
  if (unread.length > 0) {
    throw new Error(`the service config binds no field for ${unread.sort().join(", ")}`);
  }
  return bindings;
}

/**
 * `INTEGRATION-007` follow-up, ledger row 689 — the availability contract for
 * the library controls and the two session mints, derived from the routes.
 *
 * The reviewed gap was that the runbook described the credentials without ever
 * saying which operation each one makes available, or what happens when one is
 * missing. Everything the matrix asserts is read here: the gated operations and
 * their refusal codes, the keys a public bind requires, the keys the gate
 * actually consults (and therefore the ones it never does), and the startup
 * refusals that fail a misconfigured deployment closed before it serves.
 */
export function libraryControlAuthority(rustConfig, libraryRoutes) {
  const serviceValidate = rustBlockAfter(
    rustConfig,
    "fn validate(&self) -> Result<(), ServiceConfigError>",
  );
  const credentialValidate = rustBlockAfter(
    rustConfig,
    "fn validate_credentials(&self) -> Result<(), ServiceConfigError>",
  );
  if (!serviceValidate || !credentialValidate) {
    throw new Error("the service configuration validation could not be read");
  }

  const publicBindRequiredKeys = [
    ...(/for \(key, configured\) in \[([\s\S]*?)\]\s*\{/.exec(serviceValidate)?.[1] ?? "").matchAll(
      /"(VIVA_[A-Z_]+)"/g,
    ),
  ]
    .map((entry) => entry[1])
    .sort();
  if (publicBindRequiredKeys.length === 0) {
    throw new Error("the public-bind required configuration keys could not be read");
  }

  const scopedKeys = [...credentialValidate.matchAll(/"(VIVA_[A-Z_]+)"/g)].map((entry) => entry[1]);
  const credentialKeys = [...new Set([...scopedKeys, ...publicBindRequiredKeys])].sort();
  const fieldOf = configuredCredentialFields(rustConfig, credentialKeys);

  const gate = rustBlockAfter(libraryRoutes, "fn require_library_control_access(");
  const capability = rustBlockAfter(libraryRoutes, "fn validate_library_control_token(");
  if (!gate || !capability) {
    throw new Error("the library export/deletion access gate could not be read");
  }
  const gateReads = `${gate}${capability}`;
  const controlGateCredentialKeys = credentialKeys.filter((key) =>
    gateReads.includes(fieldOf.get(key)),
  );
  const controlGateUnconsultedKeys = publicBindRequiredKeys.filter(
    (key) => !controlGateCredentialKeys.includes(key),
  );
  if (controlGateCredentialKeys.length === 0 || controlGateUnconsultedKeys.length === 0) {
    throw new Error("the library control gate's configuration dependencies could not be read");
  }
  // A document can name a credential by the field it binds rather than by its
  // environment key, and that spelling of a false authority claim is the same
  // claim. Derived here so the negative rule below matches either one.
  const controlGateUnconsultedFields = controlGateUnconsultedKeys
    .map((key) => fieldOf.get(key))
    .sort();

  const authGuard =
    /if ([^\n]*is_none\(\)[\s\S]{0,160}?)\{\s*return Err\(ServiceConfigError::PublicBindMissingAuth/.exec(
      serviceValidate,
    )?.[1] ?? "";
  const publicBindAuthAlternatives = credentialKeys.filter((key) =>
    authGuard.includes(fieldOf.get(key)),
  );
  if (publicBindAuthAlternatives.length !== 2) {
    throw new Error("the public-bind authentication alternatives could not be read");
  }

  const controlGateOperations = [
    ...new Set(
      [
        ...libraryRoutes.matchAll(
          /require_library_control_access\([\s\S]{0,240}?"([a-z_]+)",\s*\)/g,
        ),
      ].map((entry) => entry[1]),
    ),
  ].sort();
  if (controlGateOperations.length === 0) {
    throw new Error("the gated library control operations could not be read");
  }
  for (const suffix of ["auth_required", "auth_failed"]) {
    if (!gate.includes(`{operation}_${suffix}`)) {
      throw new Error(`the library control gate no longer returns a \`${suffix}\` refusal`);
    }
  }
  const snapshotRefusalCodes = [
    ...new Set(
      [...libraryRoutes.matchAll(/"(library_snapshot_auth_[a-z]+)"/g)].map((entry) => entry[1]),
    ),
  ];
  if (snapshotRefusalCodes.length !== 2) {
    throw new Error("the library snapshot refusal codes could not be read");
  }
  const controlGateRefusalCodes = [
    ...controlGateOperations.flatMap((operation) => [
      `${operation}_auth_failed`,
      `${operation}_auth_required`,
    ]),
    ...snapshotRefusalCodes,
  ].sort();

  const sessionMintSelectors = [
    ...new Set(
      [...libraryRoutes.matchAll(/trimmed_selector\(query\.(\w+)\.as_deref\(\)\)/g)].map(
        (entry) => entry[1],
      ),
    ),
  ].sort();
  if (sessionMintSelectors.length !== 2) {
    throw new Error("the session mint selectors could not be read");
  }

  const startupRefusals = [
    ...new Set(
      [
        ...`${serviceValidate}${credentialValidate}`.matchAll(/ServiceConfigError::([A-Za-z]+)/g),
      ].map((entry) => entry[1]),
    ),
  ].sort();

  const controlCapabilityHeader = /"(x-viva-[a-z-]+)"/.exec(capability)?.[1] ?? null;
  const controlCapabilitySubject = /study_set_id != "([A-Za-z_]+)"/.exec(capability)?.[1] ?? null;
  const mutationUnavailableReason =
    /Some\("([a-z_]+)"\)\s*\}\s*$/.exec(
      rustBlockAfter(libraryRoutes, "fn library_mutation_access_unavailable_reason(") ?? "",
    )?.[1] ?? null;
  const noCredentialRefusalMessage = /"message": "([^"]+)"/.exec(gate)?.[1] ?? null;
  if (
    !controlCapabilityHeader ||
    !controlCapabilitySubject ||
    !mutationUnavailableReason ||
    !noCredentialRefusalMessage
  ) {
    throw new Error("the library control capability contract could not be read");
  }

  return {
    matrix_heading: LIBRARY_MATRIX_HEADING,
    control_gate_operations: controlGateOperations,
    control_gate_refusal_codes: controlGateRefusalCodes,
    control_gate_credential_keys: controlGateCredentialKeys,
    control_gate_unconsulted_fields: controlGateUnconsultedFields,
    control_gate_unconsulted_keys: controlGateUnconsultedKeys,
    control_capability_header: controlCapabilityHeader,
    control_capability_subject: controlCapabilitySubject,
    mutation_unavailable_reason: mutationUnavailableReason,
    no_credential_refusal_message: noCredentialRefusalMessage,
    public_bind_required_keys: publicBindRequiredKeys,
    public_bind_auth_alternatives: publicBindAuthAlternatives,
    session_mint_selectors: sessionMintSelectors,
    startup_refusals: startupRefusals,
  };
}

/** The body of one `##` section, or `null` when the document has no such heading. */
function markdownSection(markdown, heading) {
  const marker = `${heading}\n`;
  const start = markdown.indexOf(marker);
  if (start < 0) return null;
  const rest = markdown.slice(start + marker.length);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** A literal that can be spliced into a pattern. */
function literal(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * An alternation of derived identifiers, anchored on the left only.
 *
 * `_` is a word character, so a trailing `\b` would refuse to match the very
 * identifiers this rule is about: `library_export` inside
 * `library_export_auth_required` ends mid-word. Anchoring the left edge alone
 * keeps `xlibrary_export` out while letting a refusal code count as the
 * operation it refuses.
 */
function identifiers(values) {
  const ordered = [...values].sort((left, right) => right.length - left.length).map(literal);
  return `\\b(?:${ordered.join("|")})`;
}

/**
 * A negation, in any of the positions English puts one.
 *
 * Deliberately matched against a claim CLAUSE and never against a whole line --
 * see `claimingLines`.
 */
const DENIAL = /\b(?:never|not|no|none|nor|neither|nothing|cannot)\b|\bwithout\b|n't\b/i;

/** Punctuation that ends one clause and starts another. */
const CLAUSE_BREAK = /[.;:,|()]|--/;

/**
 * How many words before a claim can still negate it.
 *
 * A denial negates the credential or the verb, so it sits inside the claim
 * ("`KEY` never enables `study_set_delete`") or in the words that introduce the
 * credential ("it is not `KEY` that authorizes ...", "no configuration of `KEY`
 * permits ..."). Three words reach every one of those and no further.
 */
const DENIAL_LEAD_IN_WORDS = 3;

/**
 * The claim clause: the matched span, plus the few words that introduce it.
 *
 * The lead-in stops at the nearest clause break, because a negation on the far
 * side of one governs a different clause. "Operators can't skip this: `KEY`
 * authorizes `library_export`." is a false claim about `KEY` whose `can't`
 * belongs to the sentence before the colon.
 */
function claimClause(line, match) {
  const introduction = line.slice(0, match.index).split(CLAUSE_BREAK).pop() ?? "";
  const leadIn = (introduction.match(/[A-Za-z']+/g) ?? []).slice(-DENIAL_LEAD_IN_WORDS).join(" ");
  return `${leadIn} ${match[0]}`;
}

/**
 * Lines whose claim clause credits an authority, minus the ones that deny it.
 *
 * The denial test is scoped to the claim clause rather than to the whole line.
 * Testing the whole line let an unrelated negation exempt the lie beside it:
 * "Set `KEY` to enable delete; without it the controls stay closed." is a false
 * claim about `KEY` whose `without` belongs to the next clause entirely.
 */
function claimingLines(markdown, pattern) {
  const hits = [];
  for (const [index, line] of markdown.split("\n").entries()) {
    for (const match of line.matchAll(pattern)) {
      if (DENIAL.test(claimClause(line, match))) continue;
      hits.push(`line ${index + 1}: ${line.trim().slice(0, 200)}`);
      break;
    }
  }
  return hits;
}

/**
 * Every `library_control_authority` drift the runbook carries.
 *
 * The matrix must state each derived value, and no document may credit an export
 * or a delete to one of the four credentials a public bind REQUIRES but the gate
 * never reads -- that is exactly the claim an operator cannot act on.
 */
export function libraryControlDrift(privacy, runbook) {
  const authority = privacy.library_control_authority;
  const bounds = privacy.credential_length_bounds;
  const drift = [];
  const matrix = markdownSection(runbook, authority.matrix_heading);
  if (matrix === null) {
    drift.push(`omits the \`${authority.matrix_heading}\` section`);
    return drift;
  }
  for (const required of [
    ...authority.control_gate_operations,
    ...authority.control_gate_refusal_codes,
    ...authority.control_gate_credential_keys,
    ...authority.public_bind_required_keys,
    ...authority.public_bind_auth_alternatives,
    ...authority.session_mint_selectors,
    ...authority.startup_refusals,
    authority.control_capability_header,
    authority.control_capability_subject,
    authority.mutation_unavailable_reason,
    authority.no_credential_refusal_message,
    `${bounds.min_bytes}`,
    `${bounds.max_bytes}`,
  ]) {
    if (!matrix.includes(required)) {
      drift.push(`the configuration matrix omits \`${required}\``);
    }
  }
  // A claim names the credential and the operation on either side of a verb of
  // authority. Both sides are spelled the way the codebase spells them as well
  // as the way English does: the operation ids the gate guards, and the
  // configuration fields the environment keys bind. Naming only the English
  // words let the same lie through unflagged whenever it was written with a
  // real identifier -- and an identifier is how an operator would write it.
  const operations = `(?:${identifiers(authority.control_gate_operations)}|\\b(?:export|deletion|delet\\w*)\\b)`;
  const credentials = identifiers([
    ...authority.control_gate_unconsulted_keys,
    ...authority.control_gate_unconsulted_fields,
  ]);
  // Gaps are lazy so a clause is the shortest span that links the two, and they
  // never cross a sentence boundary.
  const claims = [
    new RegExp(
      `${credentials}[^.\\n]{0,140}?\\b(?:authoriz\\w*|enabl\\w*|permit\\w*|grant\\w*|unlock\\w*)\\b[^.\\n]{0,60}?${operations}`,
      "gi",
    ),
    new RegExp(
      `${operations}[^.\\n]{0,140}?\\b(?:require\\w*|uses?|used|need\\w*|present\\w*)\\b[^.\\n]{0,60}?${credentials}`,
      "gi",
    ),
  ];
  for (const claim of claims) {
    for (const hit of claimingLines(runbook, claim)) {
      drift.push(`credits an export or delete authority the gate never reads (${hit})`);
    }
  }
  return drift;
}
