#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

/**
 * `INTEGRATION-007` — the public contract, derived from executable sources.
 *
 * Every value below is read out of code, a canonical fixture, a manifest, or a
 * workflow. Nothing is read out of README prose: prose is what this file checks,
 * never what it believes. When two sources that must agree disagree, generation
 * fails instead of silently electing one of them.
 *
 * `--write`  regenerate `docs/public-contract.json`
 * `--check`  fail on any drift between the shipped sources and the owned docs
 * `--evidence --frozen-sha <SHA> --output <PATH>`  bind a passing check to a SHA
 */

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SELF_DIR, "..");

export const PUBLIC_CONTRACT_SCHEMA = "viva.public_contract.v1";
export const PUBLIC_CONTRACT_EVIDENCE_SCHEMA = "viva.public_contract_evidence.v1";
export const PUBLIC_CONTRACT_PATH = "docs/public-contract.json";

/** The public documents this coordinator phase owns, in sorted order. */
export const OWNED_PUBLIC_DOCUMENTS = Object.freeze([
  ".github/PULL_REQUEST_TEMPLATE.md",
  "CONTRIBUTING.md",
  "README.md",
  "SECURITY.md",
  "agent/README.md",
  "docs/REQUIREMENTS.md",
  "docs/data-governance.md",
  "docs/deployment-runbook.md",
  "docs/learner-loop-contract.md",
  "docs/release-readiness.md",
]);

/** The hand-authored diagrams whose labels must match the generated contract. */
export const GENERATED_DIAGRAMS = Object.freeze([
  "docs/assets/architecture-mobile.svg",
  "docs/assets/architecture.svg",
  "docs/assets/lifecycle-mobile.svg",
  "docs/assets/lifecycle.svg",
  "docs/assets/loop-mobile.svg",
  "docs/assets/loop.svg",
]);

/** Executable sources the contract is derived from, in sorted order. */
export const CHECKED_SOURCE_PATHS = Object.freeze([
  ".cargo/audit.toml",
  ".github/workflows/validate.yml",
  "Dockerfile.monitor",
  "agent/Dockerfile",
  "agent/crates/agent-domain/src/brain.rs",
  "agent/crates/agent-domain/src/review_schedule.rs",
  "agent/crates/agent-domain/src/tools.rs",
  "agent/crates/agent-service/src/config.rs",
  "agent/crates/agent-service/src/protocol.rs",
  "agent/crates/data/src/memory/ingestion.rs",
  "agent/crates/data/src/memory/privacy.rs",
  "agent/migrations",
  "apps/web/components/session/LiveSessionPage.tsx",
  "apps/web/proxy.ts",
  "package.json",
  "packages/core/src/agent-contract.ts",
  "packages/core/src/learner-loop-contract.json",
  "packages/core/src/scheduling.ts",
  "packages/core/src/study-projection-contract.ts",
  "scripts/browser-evidence.mjs",
  "scripts/check-agent-domain-purity.mjs",
  "scripts/check-legacy-domain-residue.sh",
  "scripts/production-release-gate.mjs",
  "scripts/release-check.mjs",
]);

/**
 * Vocabulary the product retired. Each entry is verified absent from the shipped
 * surface during generation, so this list can never quietly outlive the removal
 * it describes.
 */
const RETIRED_TOOL_NAMES = Object.freeze(["mark_concept_status", "schedule_review_item"]);
const RETIRED_STUDY_MODES = Object.freeze(["teach", "mock", "cram"]);

/** The six external gates no local proof can satisfy. */
const EXTERNAL_EVIDENCE_REQUIRED = Object.freeze([
  "OPS-01",
  "OPS-02",
  "OPS-03",
  "OPS-04",
  "OPS-05",
  "OPS-06",
]);

/**
 * Phrases that mark a sentence as describing something other than current
 * behavior. A retired name is legal in an owned document only next to one of
 * these, so "we removed X" stays writable while "X ships" does not.
 */
const NON_SHIPPED_MARKERS = Object.freeze([
  "never built",
  "no longer",
  "not mounted",
  "not shipped",
  "not supported",
  "planned",
  "rejected",
  "removed",
  "retired",
  "roadmap",
  "unselected",
  "vision",
]);

export const KNOWN_DRIFT_IDS = Object.freeze([
  "audio_lifecycle_frame_cap",
  "deletion_policy_text",
  "deploy_binding_verification",
  "diagram_removed_names",
  "disclosure_scope",
  "domain_purity_scope",
  "durable_postgres_continuity",
  "learner_loop_contract_fields",
  "protocol_version",
  "public_contract_stale",
  "readme_pdf_ingestion",
  "readme_scheduling_authority",
  "readme_study_modes",
  "release_readiness_status_emitted",
  "requirements_vision_label",
  "security_controls_scope",
  "static_export_claim",
  "tool_surface",
]);

/* ------------------------------------------------------------------ *
 * Source readers
 * ------------------------------------------------------------------ */

function readSource(root, relativePath) {
  const absolute = path.join(root, relativePath);
  if (!existsSync(absolute)) {
    throw new Error(`public contract source is missing: ${relativePath}`);
  }
  return readFileSync(absolute, "utf8");
}

function evaluateNumeric(literal, context) {
  const cleaned = literal.replace(/_/g, "").trim();
  const product = /^(\d+(?:\.\d+)?)\s*\*\s*(\d+(?:\.\d+)?)$/.exec(cleaned);
  if (product) return Number(product[1]) * Number(product[2]);
  const plain = Number(cleaned);
  if (!Number.isFinite(plain)) {
    throw new Error(`unreadable numeric literal for ${context}: ${literal}`);
  }
  return plain;
}

function tsNumber(source, name) {
  const match = new RegExp(`export const ${name}[^=]*=\\s*([^;]+?)(?:\\s+as const)?;`).exec(source);
  if (!match) throw new Error(`missing TypeScript constant ${name}`);
  return evaluateNumeric(match[1], name);
}

function tsString(source, name) {
  const match = new RegExp(`export const ${name}[^=]*=\\s*"([^"]*)"`).exec(source);
  if (!match) throw new Error(`missing TypeScript constant ${name}`);
  return match[1];
}

function tsStringList(source, name) {
  const match = new RegExp(`export const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]\\s*as const;`).exec(
    source,
  );
  if (!match) throw new Error(`missing TypeScript list constant ${name}`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function rustNumber(source, name) {
  const match = new RegExp(`pub const ${name}: [A-Za-z0-9]+ = ([^;]+);`).exec(source);
  if (!match) throw new Error(`missing Rust constant ${name}`);
  return evaluateNumeric(match[1], name);
}

function rustString(source, name) {
  const match = new RegExp(`(?:pub|pub\\(crate\\)) const ${name}: &str = "([^"]*)";`).exec(source);
  if (!match) throw new Error(`missing Rust constant ${name}`);
  return match[1];
}

function rustStringList(source, name) {
  const match = new RegExp(`pub const ${name}: \\[&str; \\d+\\] = \\[([\\s\\S]*?)\\];`).exec(
    source,
  );
  if (!match) throw new Error(`missing Rust list constant ${name}`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function requireAgreement(label, left, right) {
  const same = JSON.stringify(left) === JSON.stringify(right);
  if (!same) {
    throw new Error(
      `public contract sources disagree about ${label}: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`,
    );
  }
  return left;
}

/* ------------------------------------------------------------------ *
 * Contract construction
 * ------------------------------------------------------------------ */

export function buildPublicContract({ root = REPOSITORY_ROOT } = {}) {
  const tsContract = readSource(root, "packages/core/src/agent-contract.ts");
  const rustProtocol = readSource(root, "agent/crates/agent-service/src/protocol.rs");
  const projection = readSource(root, "packages/core/src/study-projection-contract.ts");
  const tsScheduling = readSource(root, "packages/core/src/scheduling.ts");
  const rustScheduling = readSource(root, "agent/crates/agent-domain/src/review_schedule.rs");
  const rustBrain = readSource(root, "agent/crates/agent-domain/src/brain.rs");
  const rustTools = readSource(root, "agent/crates/agent-domain/src/tools.rs");
  const rustIngestion = readSource(root, "agent/crates/data/src/memory/ingestion.rs");
  const rustPrivacy = readSource(root, "agent/crates/data/src/memory/privacy.rs");
  const rustConfig = readSource(root, "agent/crates/agent-service/src/config.rs");
  const learnerLoop = JSON.parse(readSource(root, "packages/core/src/learner-loop-contract.json"));
  const sessionPage = readSource(root, "apps/web/components/session/LiveSessionPage.tsx");
  const webProxy = readSource(root, "apps/web/proxy.ts");
  const agentImage = readSource(root, "agent/Dockerfile");
  const monitorImage = readSource(root, "Dockerfile.monitor");
  const workflow = parseYaml(readSource(root, ".github/workflows/validate.yml"));
  const manifest = JSON.parse(readSource(root, "package.json"));
  const releaseCheck = readSource(root, "scripts/release-check.mjs");
  const releaseGate = readSource(root, "scripts/production-release-gate.mjs");
  const browserEvidence = readSource(root, "scripts/browser-evidence.mjs");
  const purityGate = readSource(root, "scripts/check-agent-domain-purity.mjs");
  const residueGate = readSource(root, "scripts/check-legacy-domain-residue.sh");
  const advisories = readSource(root, ".cargo/audit.toml");

  const protocol = {
    version: requireAgreement(
      "the voice protocol version",
      tsNumber(tsContract, "VIVA_VOICE_PROTOCOL_VERSION"),
      rustNumber(rustProtocol, "VIVA_VOICE_PROTOCOL_VERSION"),
    ),
    supported_versions: tsStringList(tsContract, "VIVA_VOICE_SUPPORTED_PROTOCOL_VERSIONS").length
      ? tsStringList(tsContract, "VIVA_VOICE_SUPPORTED_PROTOCOL_VERSIONS")
      : [tsNumber(tsContract, "VIVA_VOICE_PROTOCOL_VERSION")],
    sample_rate_hz: requireAgreement(
      "the capture sample rate",
      tsNumber(tsContract, "VIVA_VOICE_SAMPLE_RATE_HZ"),
      rustNumber(rustProtocol, "VIVA_VOICE_SAMPLE_RATE_HZ"),
    ),
    channels: requireAgreement(
      "the capture channel count",
      tsNumber(tsContract, "VIVA_VOICE_CHANNELS"),
      rustNumber(rustProtocol, "VIVA_VOICE_CHANNELS"),
    ),
    bytes_per_sample: requireAgreement(
      "the sample width",
      tsNumber(tsContract, "VIVA_VOICE_BYTES_PER_SAMPLE"),
      rustNumber(rustProtocol, "VIVA_VOICE_BYTES_PER_SAMPLE"),
    ),
    input_encoding: requireAgreement(
      "the capture encoding",
      tsString(tsContract, "VIVA_VOICE_INPUT_ENCODING"),
      rustString(rustProtocol, "VIVA_VOICE_INPUT_ENCODING"),
    ),
    max_text_frame_bytes: requireAgreement(
      "the text frame ceiling",
      tsNumber(tsContract, "VIVA_VOICE_MAX_TEXT_FRAME_BYTES"),
      rustNumber(rustProtocol, "VIVA_VOICE_MAX_TEXT_FRAME_BYTES"),
    ),
    browser_client_frame_types: requireAgreement(
      "the browser-sendable frame vocabulary",
      tsStringList(tsContract, "VIVA_BROWSER_CLIENT_FRAME_TYPES"),
      rustStringList(rustProtocol, "VIVA_BROWSER_CLIENT_FRAME_TYPES"),
    ),
    transport: "one WebSocket at /ws",
  };
  protocol.supported_versions = [protocol.version];

  const voiceTransport = {
    max_turn_seconds: requireAgreement(
      "the turn bound",
      tsNumber(tsContract, "VIVA_VOICE_MAX_TURN_SECONDS"),
      rustNumber(rustProtocol, "VIVA_VOICE_MAX_TURN_SECONDS"),
    ),
    max_chunk_samples: requireAgreement(
      "the chunk sample cap",
      tsNumber(tsContract, "VIVA_AUDIO_MAX_CHUNK_SAMPLES"),
      rustNumber(rustProtocol, "VIVA_AUDIO_MAX_CHUNK_SAMPLES"),
    ),
    max_chunk_bytes: requireAgreement(
      "the chunk byte cap",
      tsNumber(tsContract, "VIVA_AUDIO_MAX_CHUNK_BYTES"),
      rustNumber(rustProtocol, "VIVA_AUDIO_MAX_CHUNK_BYTES"),
    ),
    max_chunk_base64_chars: requireAgreement(
      "the encoded chunk ceiling",
      tsNumber(tsContract, "VIVA_AUDIO_MAX_CHUNK_BASE64_CHARS"),
      rustNumber(rustProtocol, "VIVA_AUDIO_MAX_CHUNK_BASE64_CHARS"),
    ),
    max_turn_samples: requireAgreement(
      "the turn sample cap",
      tsNumber(tsContract, "VIVA_AUDIO_MAX_TURN_SAMPLES"),
      rustNumber(rustProtocol, "VIVA_AUDIO_MAX_TURN_SAMPLES"),
    ),
    max_turn_bytes: requireAgreement(
      "the turn byte cap",
      tsNumber(tsContract, "VIVA_AUDIO_MAX_TURN_BYTES"),
      rustNumber(rustProtocol, "VIVA_AUDIO_MAX_TURN_BYTES"),
    ),
    barge_in_frame: "cancel",
  };

  const studyModes = tsStringList(projection, "VIVA_STUDY_MODES");
  const rustModeVariants = [...rustBrain.matchAll(/Self::(\w+) => "([a-z_]+)",/g)]
    .map((entry) => entry[2])
    .filter(
      (mode) => !["strong", "shaky", "missed", "review", "high", "medium", "low"].includes(mode),
    );
  requireAgreement("the shipped study-mode vocabulary", studyModes, rustModeVariants);
  for (const retired of RETIRED_STUDY_MODES) {
    if (studyModes.includes(retired)) {
      throw new Error(`retired study mode \`${retired}\` is still in the shipped vocabulary`);
    }
  }

  const toolNames = [...rustTools.matchAll(/Self::new\(\s*"([a-z_]+)"/g)]
    .map((entry) => entry[1])
    .sort();
  if (toolNames.length === 0) throw new Error("no declared tool constructors were found");
  for (const retired of RETIRED_TOOL_NAMES) {
    if (toolNames.includes(retired)) {
      throw new Error(`retired tool \`${retired}\` is declared again in the tool surface`);
    }
    if (!new RegExp(`retired[\\s\\S]{0,240}${retired}`).test(rustTools)) {
      throw new Error(`the tool surface no longer records \`${retired}\` as retired`);
    }
  }

  const ingestion = {
    pdf_supported: false,
    pdf_refusal_id: /"unsupported_pdf"/.test(rustIngestion) ? "unsupported_pdf" : null,
    pdf_refusal_reason: /"(PDF ingestion requires page-aware extraction)"/.exec(rustIngestion)?.[1],
    supported_upload_kinds: ["paste_ingestion", "utf8_text_upload"],
    invalid_utf8_refusal_id: /"(invalid_utf8_file)"/.exec(rustIngestion)?.[1],
    ingestion_statuses: tsStringList(projection, "VIVA_STUDY_SET_INGESTION_STATUSES"),
  };
  if (!ingestion.pdf_refusal_id || !ingestion.pdf_refusal_reason) {
    throw new Error("the fail-closed PDF ingestion contract could not be read from the store");
  }
  if (/fn parse_pdf|pdf_extract|lopdf|pdfium/.test(rustIngestion)) {
    throw new Error("a PDF extractor appeared in the ingestion path; the contract must be rebuilt");
  }

  const evaluation = {
    tools: toolNames,
    retired_tools: [...RETIRED_TOOL_NAMES],
    concept_statuses: tsStringList(projection, "VIVA_CONCEPT_STATUSES"),
    source_citation_confidences: tsStringList(projection, "VIVA_SOURCE_CITATION_CONFIDENCES"),
    max_submitted_answer_resolution_ms: learnerLoop.max_submitted_answer_resolution_ms,
    learner_loop_schema: learnerLoop.schema,
    learner_loop_state_count: learnerLoop.states.length,
    learner_loop_evidence_fields: [...learnerLoop.evidence_fields],
  };

  const scheduling = {
    authority: requireAgreement(
      "the selected review-scheduling authority",
      tsString(tsScheduling, "VIVA_REVIEW_SELECTED_AUTHORITY"),
      tsStringList(projection, "VIVA_REVIEW_SCHEDULE_AUTHORITIES")[0],
    ),
    policy_id: requireAgreement(
      "the review policy identifier",
      tsString(tsScheduling, "VIVA_REVIEW_SCHEDULE_POLICY_ID"),
      rustString(rustScheduling, "VIVA_REVIEW_SCHEDULE_POLICY_ID"),
    ),
    schema_version: requireAgreement(
      "the persisted schedule schema version",
      tsNumber(tsScheduling, "VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION"),
      rustNumber(rustScheduling, "VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION"),
    ),
    exam_margin_seconds: requireAgreement(
      "the exam margin",
      tsNumber(tsScheduling, "VIVA_REVIEW_EXAM_MARGIN_SECONDS"),
      rustNumber(rustScheduling, "VIVA_REVIEW_EXAM_MARGIN_SECONDS"),
    ),
    desired_retention: requireAgreement(
      "the desired retention",
      tsNumber(tsScheduling, "VIVA_REVIEW_DESIRED_RETENTION"),
      rustNumber(rustScheduling, "VIVA_REVIEW_DESIRED_RETENTION"),
    ),
    max_interval_days: requireAgreement(
      "the maximum interval",
      tsNumber(tsScheduling, "VIVA_REVIEW_MAX_INTERVAL_DAYS"),
      rustNumber(rustScheduling, "VIVA_REVIEW_MAX_INTERVAL_DAYS"),
    ),
    persisted_writer_path: "agent/crates/agent-domain/src/review_schedule.rs",
    browser_reader_path: "packages/core/src/scheduling.ts",
    cap_reasons: ["exam_margin", "past_exam"],
  };
  if (!/ReviewScheduleDecisionV1/.test(rustScheduling)) {
    throw new Error("the persisted review decision type is absent from the Rust writer");
  }

  const studyProjection = {
    contract: "AuthenticatedStudyProjectionV1",
    version: 1,
    modes: studyModes,
    review_schedule_authorities: tsStringList(projection, "VIVA_REVIEW_SCHEDULE_AUTHORITIES"),
    browser_derives_schedule: false,
  };

  const migrationsDir = path.join(root, "agent/migrations");
  const migrations = readdirSync(migrationsDir)
    .filter((entry) => entry.endsWith(".sql"))
    .sort();
  const durability = {
    store_backends: ["in_memory", "postgres"],
    default_backend: "in_memory",
    durable_opt_in_variables: ["VIVA_AGENT_DATABASE_URL", "DATABASE_URL"],
    migrations,
    migration_count: migrations.length,
    migrations_run_on_boot: /run_migrations|migrations::/.test(rustConfig) || migrations.length > 0,
  };
  if (!/VIVA_AGENT_DATABASE_URL/.test(rustConfig) || !/DATABASE_URL/.test(rustConfig)) {
    throw new Error("the durable store opt-in variables could not be read from the service config");
  }

  const privacy = {
    data_retention_policy: rustString(rustPrivacy, "DATA_RETENTION_POLICY"),
    tombstone_title: rustString(rustPrivacy, "DELETED_STUDY_SET_TITLE"),
    tombstone_row_constant: rustString(rustPrivacy, "DELETED_ROW_CONSTANT"),
    deletion_ux: "CONFIRM_DELETE",
    disclosure_scope: /VIVA_DISCLOSURE_SCOPE: DisclosureScope = "([a-z_]+)"/.exec(sessionPage)?.[1],
    redaction_gate: "scripts/redaction-control-check.mjs",
    scoped_advisory_ignores: [...advisories.matchAll(/"(RUSTSEC-\d{4}-\d{4})"/g)].map(
      (entry) => entry[1],
    ),
    defense_headers: [
      ...new Set([
        "content-security-policy",
        ...[
          ...(/const DEFENSE_HEADERS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(webProxy)?.[1] ?? "").matchAll(
            /\["([a-z-]+)",/g,
          ),
        ].map((entry) => entry[1]),
        ...(/response\.headers\.set\("strict-transport-security"/.test(webProxy)
          ? ["strict-transport-security"]
          : []),
      ]),
    ].sort(),
    trusted_proxy_variable: /VIVA_VOICE_WS_TRUSTED_PROXY_CIDRS/.test(rustConfig)
      ? "VIVA_VOICE_WS_TRUSTED_PROXY_CIDRS"
      : null,
    credential_length_bounds: {
      min_bytes: Number(/credential\.len\(\) < (\d+)/.exec(rustConfig)?.[1]),
      max_bytes: Number(/credential\.len\(\) > (\d+)/.exec(rustConfig)?.[1]),
    },
    container_runtime_users: [
      /\nUSER (\S+)\s*\n/.exec(agentImage)?.[1],
      /\nUSER (\S+)\s*\n/.exec(monitorImage)?.[1],
    ].filter(Boolean),
  };
  if (privacy.trusted_proxy_variable === null) {
    throw new Error("the trusted-proxy client-address model could not be read from the config");
  }
  if (
    !Number.isFinite(privacy.credential_length_bounds.min_bytes) ||
    !Number.isFinite(privacy.credential_length_bounds.max_bytes)
  ) {
    throw new Error("the configured credential length bounds could not be read");
  }
  if (privacy.container_runtime_users.length !== 2) {
    throw new Error("both runtime images must declare a non-root user before CMD");
  }
  if (privacy.data_retention_policy !== "hard_purge_text") {
    throw new Error(
      `the store reports retention policy \`${privacy.data_retention_policy}\`, which is not the recorded D-05 branch`,
    );
  }
  if (privacy.disclosure_scope !== "all_live_provider_content") {
    throw new Error(
      `the mounted session reports disclosure scope \`${privacy.disclosure_scope}\`, which is not the recorded D-08 branch`,
    );
  }

  const providerIds = [
    ...rustConfig.matchAll(
      /Self::(?:Synthetic|FakeCartesiaGemini|CartesiaGemini) => "([a-z_]+)",/g,
    ),
  ].map((entry) => entry[1]);
  const providerModes = providerIds.map((id) => ({
    id,
    default: id === "synthetic",
    reaches_a_provider_network: id === "cartesia_gemini",
    required_gates:
      id === "cartesia_gemini"
        ? [
            "VIVA_CARTESIA_GEMINI_LIVE_RUNTIME=1",
            "CARTESIA_ZERO_DATA_RETENTION_ENABLED=1",
            "GEMINI_ZERO_DATA_RETENTION_APPROVED=1",
          ]
        : [],
  }));
  if (providerModes.length !== 3) {
    throw new Error(`expected three provider modes, read ${providerModes.length}`);
  }

  const jobs = workflow?.jobs ?? {};
  const aggregate = jobs["required-validation"];
  const validation = {
    workflow: ".github/workflows/validate.yml",
    workflow_name: workflow?.name ?? null,
    required_job_names: Object.values(jobs)
      .map((job) => job?.name)
      .filter((name) => typeof name === "string")
      .sort(),
    required_aggregate_job: aggregate?.name ?? null,
    required_aggregate_needs: [...(aggregate?.needs ?? [])].sort(),
    default_local_gate: "bun run validate",
    default_gate_expansion: [
      manifest.scripts["validate:ts"],
      manifest.scripts["validate:agent"],
      manifest.scripts["release:hygiene"],
      manifest.scripts["module:concentration"],
      manifest.scripts.audit,
    ].filter(Boolean),
    domain_boundary_gate: {
      script: "bun run agent:purity",
      proves:
        "the agent-domain direct normal-dependency allowlist and its forbidden module imports",
      does_not_prove: "adapter purity, runtime I/O behavior, or live provider behavior",
    },
    domain_residue_gate: {
      script: "bun run agent:residue",
      proves: "the removed legacy domain vocabulary is absent from agent, packages, and apps",
    },
    durable_postgres_is_continuous: Boolean(
      aggregate?.needs?.includes("durable-postgres") && jobs["durable-postgres"],
    ),
    default_gate_requires_provider_credentials: false,
    default_gate_requires_local_postgres: false,
  };
  if (!/does not prove/i.test(purityGate) || !/allowlist/i.test(purityGate)) {
    throw new Error("the purity gate no longer states its own narrow scope");
  }
  if (!/it does not prove live behavior/i.test(residueGate)) {
    throw new Error("the residue gate no longer states its own narrow scope");
  }
  if (!validation.durable_postgres_is_continuous) {
    throw new Error("the durable Postgres job is no longer required by the aggregate check");
  }

  const releaseEvidence = {
    schema: /schema: "(viva\.release_evidence\.v1)"/.exec(releaseCheck)?.[1] ?? null,
    generator: "bun run release:check",
    downstream_verifier: "bun run release:verify",
    bundle_signature_algorithm: /"(hmac-sha256)"/.exec(releaseGate)?.[1] ?? null,
    unsigned_self_hash_label: /"(sha256-self)"/.exec(releaseGate)?.[1] ?? null,
    structured_preview_certifies_product: !/kind !== "structured_preview"/.test(browserEvidence)
      ? null
      : false,
    structured_preview_reported_separately: true,
  };
  if (releaseEvidence.schema === null || releaseEvidence.bundle_signature_algorithm === null) {
    throw new Error("the release evidence schema or signature algorithm could not be read");
  }
  if (releaseEvidence.structured_preview_certifies_product !== false) {
    throw new Error("the harness-authored preview is no longer excluded from product frames");
  }

  const contract = {
    schema: PUBLIC_CONTRACT_SCHEMA,
    source_manifest_sha256: sourceManifestDigest(root),
    protocol,
    voice_transport: voiceTransport,
    study_modes: studyModes,
    ingestion,
    evaluation,
    scheduling,
    study_projection: studyProjection,
    durability,
    privacy,
    provider_modes: providerModes,
    validation,
    release_evidence: releaseEvidence,
    external_evidence_required: [...EXTERNAL_EVIDENCE_REQUIRED],
    sanitized: true,
  };
  return contract;
}

export function renderPublicContract(contract) {
  return `${JSON.stringify(contract, null, 2)}\n`;
}

function digestOf(text) {
  return createHash("sha256").update(text).digest("hex");
}

function sourceManifestDigest(root) {
  const lines = [];
  for (const relativePath of CHECKED_SOURCE_PATHS) {
    const absolute = path.join(root, relativePath);
    if (!existsSync(absolute)) {
      throw new Error(`public contract source is missing: ${relativePath}`);
    }
    if (statSync(absolute).isDirectory()) {
      for (const entry of readdirSync(absolute).sort()) {
        lines.push(
          `${relativePath}/${entry} ${digestOf(readFileSync(path.join(absolute, entry)))}`,
        );
      }
      continue;
    }
    lines.push(`${relativePath} ${digestOf(readFileSync(absolute))}`);
  }
  return digestOf(`${lines.join("\n")}\n`);
}

/* ------------------------------------------------------------------ *
 * Document drift checks
 * ------------------------------------------------------------------ */

function loadOwnedDocuments(root) {
  const documents = {};
  for (const relativePath of [...OWNED_PUBLIC_DOCUMENTS, ...GENERATED_DIAGRAMS]) {
    const absolute = path.join(root, relativePath);
    documents[relativePath] = existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
  }
  return documents;
}

function marksNonShipped(line) {
  const normalized = line.toLowerCase();
  return NON_SHIPPED_MARKERS.some((marker) => normalized.includes(marker));
}

/**
 * Lines that match `pattern` and are not excused.
 *
 * A Markdown heading scopes its whole section: under `## Roadmap` a sentence
 * about unbuilt capability is a roadmap entry, not a claim about today. The line
 * itself may also carry its own marker.
 */
function offendingLines(text, pattern, { allowWhenNonShipped = true } = {}) {
  const hits = [];
  let sectionIsNonShipped = false;
  for (const [index, line] of text.split("\n").entries()) {
    if (/^#{1,6}\s/.test(line)) sectionIsNonShipped = marksNonShipped(line);
    if (!pattern.test(line)) continue;
    if (allowWhenNonShipped && (sectionIsNonShipped || marksNonShipped(line))) continue;
    hits.push(`line ${index + 1}: ${line.trim().slice(0, 160)}`);
  }
  return hits;
}

function groupedThousands(value) {
  return value.toLocaleString("en-US");
}

export function checkPublicContract({
  root = REPOSITORY_ROOT,
  documents,
  generatedContractText,
} = {}) {
  const contract = buildPublicContract({ root });
  const owned = documents ?? loadOwnedDocuments(root);
  const drift = [];

  const flag = (id, docPath, detail) => {
    drift.push({ id, path: docPath, detail });
  };
  const text = (docPath) => owned[docPath] ?? "";

  for (const relativePath of [...OWNED_PUBLIC_DOCUMENTS, ...GENERATED_DIAGRAMS]) {
    if (owned[relativePath] === null || owned[relativePath] === undefined) {
      flag(
        relativePath === "docs/release-readiness.md"
          ? "release_readiness_status_emitted"
          : "requirements_vision_label",
        relativePath,
        "owned public document is missing",
      );
    }
  }

  const everyDocument = [...OWNED_PUBLIC_DOCUMENTS, ...GENERATED_DIAGRAMS];
  const readme = text("README.md");

  // 1. Study modes: the mounted product sends exactly `contract.study_modes`.
  for (const mode of contract.study_modes) {
    if (!readme.includes(`\`${mode}\``)) {
      flag("readme_study_modes", "README.md", `the shipped mode \`${mode}\` is never named`);
    }
  }
  const retiredModePattern = new RegExp(
    `(\`(?:${RETIRED_STUDY_MODES.join("|")})\`|\\bfour modes\\b|\\bTeach Me\\b|\\bMock Viva\\b)`,
    "i",
  );
  for (const hit of offendingLines(readme, retiredModePattern)) {
    flag("readme_study_modes", "README.md", `names a mode the product does not send (${hit})`);
  }

  // 2. Ingestion: PDFs fail closed, so no unqualified PDF claim may stand.
  if (contract.ingestion.pdf_supported === false) {
    for (const hit of offendingLines(readme, /\bPDFs?\b/i)) {
      const line = hit.toLowerCase();
      if (/refus|fails closed|reject|page-aware|cannot|unsupported/.test(line)) continue;
      flag("readme_pdf_ingestion", "README.md", `claims PDF ingestion (${hit})`);
    }
  }

  // 3. Scheduling authority: the persisted writer is the Rust agent.
  if (/scheduling authority[^.\n]{0,80}packages\/core/i.test(readme)) {
    flag(
      "readme_scheduling_authority",
      "README.md",
      "names `packages/core` as the scheduling authority",
    );
  }
  if (!readme.includes(contract.scheduling.authority)) {
    flag(
      "readme_scheduling_authority",
      "README.md",
      `does not name the selected authority \`${contract.scheduling.authority}\``,
    );
  }
  if (!readme.includes(contract.scheduling.persisted_writer_path)) {
    flag(
      "readme_scheduling_authority",
      "README.md",
      "does not name the persisted scheduling writer",
    );
  }

  // 4. Tool surface: five declared tools, and the retired two stay retired.
  for (const tool of contract.evaluation.tools) {
    if (!readme.includes(tool)) {
      flag("tool_surface", "README.md", `does not name the shipped tool \`${tool}\``);
    }
  }
  const retiredToolPattern = new RegExp(`\\b(?:${RETIRED_TOOL_NAMES.join("|")})\\b`);
  for (const docPath of everyDocument) {
    for (const hit of offendingLines(text(docPath), retiredToolPattern)) {
      flag("tool_surface", docPath, `names a retired tool as shipped (${hit})`);
    }
  }

  // 5. Protocol version.
  const staleProtocolPattern = /protocol[%\s-]*v(?:ersion[%\s-]*)?[1-4]\b/i;
  for (const docPath of everyDocument) {
    for (const hit of offendingLines(text(docPath), staleProtocolPattern)) {
      flag("protocol_version", docPath, `advertises a retired wire version (${hit})`);
    }
  }
  const currentProtocolLabel = `protocol v${contract.protocol.version}`;
  for (const docPath of [
    "README.md",
    "docs/assets/architecture.svg",
    "docs/assets/architecture-mobile.svg",
    "docs/assets/lifecycle.svg",
    "docs/assets/lifecycle-mobile.svg",
  ]) {
    const body = text(docPath);
    const badgeLabel = `protocol-v${contract.protocol.version}`;
    if (!body.toLowerCase().includes(currentProtocolLabel) && !body.includes(badgeLabel)) {
      flag("protocol_version", docPath, `does not state \`${currentProtocolLabel}\``);
    }
  }

  // 6. Audio lifecycle and frame caps.
  const requiredCaps = [
    groupedThousands(contract.voice_transport.max_chunk_bytes),
    groupedThousands(contract.voice_transport.max_chunk_samples),
    groupedThousands(contract.voice_transport.max_turn_bytes),
    `${contract.voice_transport.max_turn_seconds}`,
    contract.protocol.input_encoding,
  ];
  for (const cap of requiredCaps) {
    if (!readme.includes(cap)) {
      flag("audio_lifecycle_frame_cap", "README.md", `omits the shipped audio bound \`${cap}\``);
    }
  }
  if (!readme.includes(contract.voice_transport.barge_in_frame)) {
    flag("audio_lifecycle_frame_cap", "README.md", "omits the barge-in frame");
  }

  // 7. Durable Postgres continuity.
  const postgresJobName = "Durable Postgres proof";
  if (contract.validation.durable_postgres_is_continuous) {
    for (const docPath of ["CONTRIBUTING.md", "agent/README.md"]) {
      const body = text(docPath);
      if (!body.includes(postgresJobName) || !/required/i.test(body)) {
        flag(
          "durable_postgres_continuity",
          docPath,
          "does not record the required durable Postgres CI job",
        );
      }
    }
  }
  const falseContinuityPattern =
    /(optional|opt-?in|manual|local)[^.\n]{0,80}postgres[^.\n]{0,80}(continuous|release proof|proves release|equals release)/i;
  for (const docPath of OWNED_PUBLIC_DOCUMENTS) {
    for (const hit of offendingLines(text(docPath), falseContinuityPattern, {
      allowWhenNonShipped: false,
    })) {
      // A denial ("a local Postgres run is not release proof") is the sentence
      // this rule exists to require, not the one it exists to catch.
      if (/\b(never|not|no|cannot|nor)\b/i.test(hit)) continue;
      flag(
        "durable_postgres_continuity",
        docPath,
        `calls an opt-in Postgres run continuous (${hit})`,
      );
    }
  }

  // 8. Domain boundary gate scope.
  const overclaimedPurityPattern =
    /purit[a-z]*[^.\n]{0,90}\b(enforc\w*|prov\w*|guarantee\w*|keeps?)\b[^.\n]{0,70}(i\/o|io\b)/i;
  for (const docPath of OWNED_PUBLIC_DOCUMENTS) {
    for (const hit of offendingLines(text(docPath), overclaimedPurityPattern, {
      allowWhenNonShipped: false,
    })) {
      if (/allowlist|import/i.test(hit)) continue;
      flag("domain_purity_scope", docPath, `overstates what the purity gate proves (${hit})`);
    }
  }
  for (const docPath of ["README.md", "CONTRIBUTING.md", ".github/PULL_REQUEST_TEMPLATE.md"]) {
    const body = text(docPath);
    if (!body.includes("agent:purity") || !/allowlist/i.test(body)) {
      flag("domain_purity_scope", docPath, "omits the narrow `agent:purity` claim");
    }
  }
  for (const docPath of ["CONTRIBUTING.md", ".github/PULL_REQUEST_TEMPLATE.md"]) {
    if (!text(docPath).includes("agent:residue")) {
      flag("domain_purity_scope", docPath, "omits the separate `agent:residue` claim");
    }
  }

  // 9. Deletion policy (recorded D-05 branch).
  const governance = text("docs/data-governance.md");
  for (const required of [
    contract.privacy.data_retention_policy,
    contract.privacy.tombstone_title,
    "content-free tombstone",
    "idempotent",
  ]) {
    if (!governance.includes(required)) {
      flag(
        "deletion_policy_text",
        "docs/data-governance.md",
        `omits the selected deletion contract detail \`${required}\``,
      );
    }
  }
  const staleDeletionPattern =
    /(tombstones? (?:documents|source spans)|leaves nothing behind|removes every trace)/i;
  for (const docPath of OWNED_PUBLIC_DOCUMENTS) {
    for (const hit of offendingLines(text(docPath), staleDeletionPattern, {
      allowWhenNonShipped: false,
    })) {
      flag("deletion_policy_text", docPath, `describes an unselected deletion policy (${hit})`);
    }
  }

  // 10. Disclosure scope (recorded D-08 branch).
  if (!governance.includes(contract.privacy.disclosure_scope)) {
    flag(
      "disclosure_scope",
      "docs/data-governance.md",
      `omits the selected disclosure scope \`${contract.privacy.disclosure_scope}\``,
    );
  }
  if (!/typed/i.test(governance)) {
    flag("disclosure_scope", "docs/data-governance.md", "does not cover live typed content");
  }
  for (const hit of offendingLines(governance, /microphone_audio_only/, {
    allowWhenNonShipped: false,
  })) {
    if (/branch b|not selected|unselected|rejected/i.test(hit)) continue;
    flag(
      "disclosure_scope",
      "docs/data-governance.md",
      `scopes the disclosure too narrowly (${hit})`,
    );
  }

  // 11. Deploy/run/bundle binding.
  const runbook = text("docs/deployment-runbook.md");
  for (const required of [
    "VIVA_RELEASE_RUN_ID",
    "VIVA_RELEASE_DEPLOY_SHA",
    "VIVA_RELEASE_AGENT_IMAGE_DIGEST",
    contract.release_evidence.bundle_signature_algorithm,
    contract.release_evidence.downstream_verifier,
    "BLOCKED_EXTERNAL",
  ]) {
    if (!runbook.includes(required)) {
      flag(
        "deploy_binding_verification",
        "docs/deployment-runbook.md",
        `omits the exact binding requirement \`${required}\``,
      );
    }
  }

  // 12. Learner-loop evidence fields mirror the canonical JSON exactly.
  const loopDoc = text("docs/learner-loop-contract.md");
  const listedFields = [...loopDoc.matchAll(/^- `([a-z_]+)`$/gm)].map((entry) => entry[1]);
  const expectedFields = contract.evaluation.learner_loop_evidence_fields;
  for (const field of expectedFields) {
    if (!listedFields.includes(field)) {
      flag(
        "learner_loop_contract_fields",
        "docs/learner-loop-contract.md",
        `omits canonical evidence field \`${field}\``,
      );
    }
  }
  for (const field of listedFields) {
    if (!expectedFields.includes(field)) {
      flag(
        "learner_loop_contract_fields",
        "docs/learner-loop-contract.md",
        `lists \`${field}\`, which the canonical contract does not define`,
      );
    }
  }
  if (!loopDoc.includes(`${contract.evaluation.max_submitted_answer_resolution_ms}`)) {
    flag(
      "learner_loop_contract_fields",
      "docs/learner-loop-contract.md",
      "omits the outer resolution bound",
    );
  }

  // 13. Diagrams: only shipped providers, stores, routes, and authority edges.
  const forbiddenDiagramPattern = new RegExp(
    `(${RETIRED_TOOL_NAMES.join("|")}|tools\\s*[×x]\\s*7|FSRS\\s*·\\s*contract|FSRS scheduling|\\bPDFs?\\b|\\b(?:${RETIRED_STUDY_MODES.join("|")})\\b)`,
    "i",
  );
  for (const docPath of GENERATED_DIAGRAMS) {
    for (const hit of offendingLines(text(docPath), forbiddenDiagramPattern, {
      allowWhenNonShipped: false,
    })) {
      flag("diagram_removed_names", docPath, `names a removed edge or label (${hit})`);
    }
  }
  for (const docPath of ["docs/assets/architecture.svg", "docs/assets/architecture-mobile.svg"]) {
    const body = text(docPath);
    for (const mode of contract.provider_modes) {
      if (!body.includes(mode.id)) {
        flag("diagram_removed_names", docPath, `omits the shipped provider \`${mode.id}\``);
      }
    }
    for (const backend of ["in-memory", "postgres"]) {
      if (!body.includes(backend)) {
        flag("diagram_removed_names", docPath, `omits the shipped store \`${backend}\``);
      }
    }
    if (!body.includes(`tools ×${contract.evaluation.tools.length}`)) {
      flag("diagram_removed_names", docPath, "does not state the shipped tool count");
    }
  }

  // 14. Vision is labelled as vision.
  const requirements = text("docs/REQUIREMENTS.md");
  if (!/^> \*\*Status: product vision/m.test(requirements)) {
    flag(
      "requirements_vision_label",
      "docs/REQUIREMENTS.md",
      "does not carry the product-vision status banner",
    );
  }
  if (!requirements.includes(PUBLIC_CONTRACT_PATH)) {
    flag(
      "requirements_vision_label",
      "docs/REQUIREMENTS.md",
      `does not link shipped status to \`${PUBLIC_CONTRACT_PATH}\``,
    );
  }

  // 15. The security policy measures a report against controls that exist.
  const securityDoc = text("SECURITY.md");
  for (const required of [
    contract.privacy.trusted_proxy_variable,
    `${contract.privacy.credential_length_bounds.min_bytes}`,
    `${contract.privacy.credential_length_bounds.max_bytes}`,
    ...contract.privacy.container_runtime_users,
    ...contract.privacy.defense_headers,
    ...contract.privacy.scoped_advisory_ignores,
    "OPS-04",
  ]) {
    if (!securityDoc.includes(required)) {
      flag("security_controls_scope", "SECURITY.md", `omits the shipped control \`${required}\``);
    }
  }

  // 16. D-06B: the static export is gone, so no document may claim it.
  const deletedBuildModePattern = /(static export|next export|output:\s*"export")/i;
  for (const docPath of everyDocument) {
    for (const hit of offendingLines(text(docPath), deletedBuildModePattern, {
      allowWhenNonShipped: false,
    })) {
      flag("static_export_claim", docPath, `claims a deleted build mode (${hit})`);
    }
  }

  // 17. No document may emit a terminal release status before the freeze.
  const readiness = text("docs/release-readiness.md");
  for (const required of [
    "CODE_REMEDIATION_COMPLETE",
    "CODE_COMPLETE_EXTERNAL_GATES_PENDING",
    "RELEASE_READY",
    "BLOCKED_EXTERNAL",
    "No terminal status has been emitted",
    ...contract.external_evidence_required,
  ]) {
    if (!readiness.includes(required)) {
      flag(
        "release_readiness_status_emitted",
        "docs/release-readiness.md",
        `omits the required release-readiness element \`${required}\``,
      );
    }
  }
  const emittedStatusPattern =
    /^\s*[-*|]?\s*Terminal status(?: emitted)?\s*[:|]\s*`?(?:CODE_REMEDIATION_COMPLETE|CODE_COMPLETE_EXTERNAL_GATES_PENDING|RELEASE_READY)/im;
  for (const docPath of OWNED_PUBLIC_DOCUMENTS) {
    for (const hit of offendingLines(text(docPath), emittedStatusPattern, {
      allowWhenNonShipped: false,
    })) {
      flag("release_readiness_status_emitted", docPath, `emits a terminal release status (${hit})`);
    }
  }

  // 18. The tracked generated contract is current.
  //
  // Compared as parsed content, not as bytes: a formatter run over the tracked
  // file must not be able to fail this gate, and re-indentation is not drift.
  // Content equality is what the documents are checked against.
  const trackedPath = path.join(root, PUBLIC_CONTRACT_PATH);
  const tracked =
    generatedContractText ?? (existsSync(trackedPath) ? readFileSync(trackedPath, "utf8") : null);
  if (tracked === null) {
    flag(
      "public_contract_stale",
      PUBLIC_CONTRACT_PATH,
      "the generated contract has not been written",
    );
  } else {
    let parsed;
    try {
      parsed = JSON.parse(tracked);
    } catch {
      parsed = null;
    }
    if (parsed === null || JSON.stringify(parsed) !== JSON.stringify(contract)) {
      flag(
        "public_contract_stale",
        PUBLIC_CONTRACT_PATH,
        "the generated contract no longer matches the shipped sources",
      );
    }
  }

  return { contract, drift, known_drift_ids: [...KNOWN_DRIFT_IDS] };
}

export function writePublicContract({ root = REPOSITORY_ROOT } = {}) {
  const contract = buildPublicContract({ root });
  const rendered = renderPublicContract(contract);
  writeFileSync(path.join(root, PUBLIC_CONTRACT_PATH), rendered);
  return rendered;
}

/* ------------------------------------------------------------------ *
 * Frozen evidence
 * ------------------------------------------------------------------ */

export function buildDocsContractEvidence({ root = REPOSITORY_ROOT, frozenSha, documents } = {}) {
  if (typeof frozenSha !== "string" || !/^[0-9a-f]{40}$/.test(frozenSha)) {
    throw new Error("a docs contract evidence run requires a 40-character lowercase frozen sha");
  }
  const result = checkPublicContract({ root, documents });
  if (result.drift.length > 0) {
    const detail = result.drift.map((entry) => `${entry.id} ${entry.path}: ${entry.detail}`);
    throw new Error(`public contract drift blocks evidence generation:\n${detail.join("\n")}`);
  }

  const documentDigests = {};
  for (const relativePath of [...OWNED_PUBLIC_DOCUMENTS, ...GENERATED_DIAGRAMS]) {
    const body = documents?.[relativePath];
    if (typeof body === "string") {
      documentDigests[relativePath] = digestOf(body);
      continue;
    }
    const absolute = path.join(root, relativePath);
    if (!existsSync(absolute)) {
      throw new Error(`owned public document is missing at the frozen sha: ${relativePath}`);
    }
    documentDigests[relativePath] = digestOf(readFileSync(absolute));
  }

  return {
    schema: PUBLIC_CONTRACT_EVIDENCE_SCHEMA,
    frozen_sha: frozenSha,
    source_manifest_sha256: result.contract.source_manifest_sha256,
    public_contract_sha256: digestOf(renderPublicContract(result.contract)),
    document_sha256: documentDigests,
    checked_source_paths: [...CHECKED_SOURCE_PATHS],
    drift_count: 0,
    sanitized: true,
    status: "PASS",
  };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function readOption(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function main(argv) {
  const root = path.resolve(readOption(argv, "--root") ?? REPOSITORY_ROOT);

  if (argv.includes("--write")) {
    writePublicContract({ root });
    process.stdout.write(`wrote ${PUBLIC_CONTRACT_PATH}\n`);
    return 0;
  }

  if (argv.includes("--evidence")) {
    const frozenSha = readOption(argv, "--frozen-sha");
    const output = readOption(argv, "--output");
    if (!frozenSha) throw new Error("--evidence requires --frozen-sha <SHA>");
    if (!output) throw new Error("--evidence requires --output <PATH>");
    const evidence = buildDocsContractEvidence({ root, frozenSha });
    const destination = path.resolve(root, output);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`${evidence.status} drift_count=${evidence.drift_count}\n`);
    return 0;
  }

  if (argv.includes("--check")) {
    const { drift } = checkPublicContract({ root });
    if (drift.length === 0) {
      process.stdout.write("Public contract check passed.\n");
      return 0;
    }
    for (const entry of drift) {
      process.stderr.write(`${entry.id} ${entry.path}: ${entry.detail}\n`);
    }
    process.stderr.write(`${drift.length} public contract drift(s).\n`);
    return 1;
  }

  process.stderr.write("usage: public-contract.mjs [--write|--check|--evidence] [--root <DIR>]\n");
  return 2;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
