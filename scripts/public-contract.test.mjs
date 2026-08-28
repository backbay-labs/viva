import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildDocsContractEvidence,
  buildPublicContract,
  CHECKED_SOURCE_PATHS,
  checkPublicContract,
  GENERATED_DIAGRAMS,
  OWNED_PUBLIC_DOCUMENTS,
  PUBLIC_CONTRACT_EVIDENCE_SCHEMA,
  PUBLIC_CONTRACT_PATH,
  PUBLIC_CONTRACT_SCHEMA,
  renderPublicContract,
} from "./public-contract.mjs";

/**
 * `INTEGRATION-007`: the public contract is derived from executable sources, and
 * every owned public document is pinned to that derivation.
 *
 * These tests are the drift oracle. Each mutation below is a claim the reviewed
 * documents actually made at the audit base; if a future edit reintroduces one,
 * the matching drift id must come back rather than the prose silently winning.
 */

const FROZEN_SHA_FIXTURE = "0123456789abcdef0123456789abcdef01234567";

function documentsFromDisk() {
  const documents = {};
  for (const relativePath of [...OWNED_PUBLIC_DOCUMENTS, ...GENERATED_DIAGRAMS]) {
    documents[relativePath] = readFileSync(relativePath, "utf8");
  }
  return documents;
}

function driftIds(result) {
  return result.drift.map((entry) => entry.id).sort();
}

function checkWith(mutate) {
  const documents = documentsFromDisk();
  mutate(documents);
  return checkPublicContract({ documents });
}

function assertDrift(result, id) {
  assert.ok(
    result.drift.some((entry) => entry.id === id),
    `expected drift \`${id}\`, saw ${JSON.stringify(driftIds(result))}`,
  );
}

test("the generated contract carries exactly the plan's top-level field set", () => {
  const contract = buildPublicContract();

  assert.equal(contract.schema, PUBLIC_CONTRACT_SCHEMA);
  assert.equal(PUBLIC_CONTRACT_SCHEMA, "viva.public_contract.v1");
  assert.equal(PUBLIC_CONTRACT_EVIDENCE_SCHEMA, "viva.public_contract_evidence.v1");
  assert.equal(PUBLIC_CONTRACT_PATH, "docs/public-contract.json");
  assert.deepEqual(Object.keys(contract), [
    "schema",
    "source_manifest_sha256",
    "protocol",
    "voice_transport",
    "study_modes",
    "ingestion",
    "evaluation",
    "scheduling",
    "study_projection",
    "durability",
    "privacy",
    "provider_modes",
    "validation",
    "release_evidence",
    "external_evidence_required",
    "sanitized",
  ]);
  assert.match(contract.source_manifest_sha256, /^[0-9a-f]{64}$/);
  assert.equal(contract.sanitized, true);
});

test("the contract is derived from the shipped sources, not from README prose", () => {
  const contract = buildPublicContract();

  // Voice protocol: v5 on both sides of the wire.
  assert.equal(contract.protocol.version, 5);
  assert.deepEqual(contract.protocol.supported_versions, [5]);
  assert.equal(contract.protocol.input_encoding, "pcm_s16le");
  assert.equal(contract.protocol.sample_rate_hz, 24_000);
  assert.deepEqual(contract.protocol.browser_client_frame_types, [
    "session_config",
    "session_refresh",
    "audio_chunk",
    "audio_end",
    "turn_intent",
    "cancel",
    "stop",
  ]);

  // Audio lifecycle / frame caps.
  assert.equal(contract.voice_transport.max_turn_seconds, 45);
  assert.equal(contract.voice_transport.max_chunk_samples, 4_096);
  assert.equal(contract.voice_transport.max_chunk_bytes, 8_192);
  assert.equal(contract.voice_transport.max_chunk_base64_chars, 10_924);
  assert.equal(contract.voice_transport.max_turn_samples, 1_080_000);
  assert.equal(contract.voice_transport.max_turn_bytes, 2_160_000);

  // D-03B: one mounted mode.
  assert.deepEqual(contract.study_modes, ["quiz"]);

  // DATA-014: PDFs fail closed; there is no page-aware extraction.
  assert.equal(contract.ingestion.pdf_supported, false);
  assert.equal(contract.ingestion.pdf_refusal_id, "unsupported_pdf");
  assert.deepEqual(contract.ingestion.supported_upload_kinds, [
    "paste_ingestion",
    "utf8_text_upload",
  ]);
  assert.equal(contract.ingestion.invalid_utf8_refusal_id, "invalid_utf8_file");

  // LEARN-009: five declared tools; mastery and scheduling are not model-selected.
  assert.deepEqual(contract.evaluation.tools, [
    "build_session_recap",
    "challenge_correction",
    "evaluate_spoken_answer",
    "retrieve_source_reference",
    "select_next_question",
  ]);
  assert.deepEqual(contract.evaluation.retired_tools, [
    "mark_concept_status",
    "schedule_review_item",
  ]);
  assert.deepEqual(contract.evaluation.concept_statuses, ["strong", "shaky", "missed", "review"]);
  assert.equal(contract.evaluation.max_submitted_answer_resolution_ms, 45_000);
  assert.equal(contract.evaluation.learner_loop_evidence_fields.length, 15);

  // D-01: the persisted writer is the Rust agent, not `packages/core`.
  assert.equal(contract.scheduling.authority, "server_persisted_fsrs");
  assert.equal(contract.scheduling.policy_id, "viva.fsrs6-default.1");
  assert.equal(contract.scheduling.exam_margin_seconds, 86_400);
  assert.equal(contract.scheduling.desired_retention, 0.9);
  assert.equal(
    contract.scheduling.persisted_writer_path,
    "agent/crates/agent-domain/src/review_schedule.rs",
  );
  assert.equal(contract.scheduling.browser_reader_path, "packages/core/src/scheduling.ts");

  // D-05 / D-08A.
  assert.equal(contract.privacy.data_retention_policy, "hard_purge_text");
  assert.equal(contract.privacy.tombstone_title, "[deleted]");
  assert.equal(contract.privacy.disclosure_scope, "all_live_provider_content");

  // Durability and validation.
  assert.deepEqual(contract.durability.store_backends, ["in_memory", "postgres"]);
  assert.equal(contract.durability.migration_count, contract.durability.migrations.length);
  assert.ok(contract.validation.required_job_names.includes("Durable Postgres proof"));
  assert.equal(contract.validation.required_aggregate_job, "Required validation");
  assert.equal(contract.release_evidence.schema, "viva.release_evidence.v1");
  assert.equal(contract.release_evidence.bundle_signature_algorithm, "hmac-sha256");
  assert.deepEqual(contract.external_evidence_required, [
    "OPS-01",
    "OPS-02",
    "OPS-03",
    "OPS-04",
    "OPS-05",
    "OPS-06",
  ]);

  // D-09B: the harness preview is evidence about the harness, never product proof.
  assert.equal(contract.release_evidence.structured_preview_certifies_product, false);
});

test("generation is deterministic and the tracked contract is current", () => {
  const first = renderPublicContract(buildPublicContract());
  const second = renderPublicContract(buildPublicContract());

  // `--write` is byte-deterministic, so a second run never produces a diff.
  assert.equal(first, second);
  assert.ok(first.endsWith("\n"));

  // The tracked file is compared as content, so a formatter run over it is not
  // drift; a changed value still is.
  assert.deepEqual(
    JSON.parse(readFileSync(PUBLIC_CONTRACT_PATH, "utf8")),
    JSON.parse(first),
    "docs/public-contract.json is stale; run `node scripts/public-contract.mjs --write`",
  );
});

test("every owned public document and diagram is covered and currently drift-free", () => {
  assert.deepEqual(OWNED_PUBLIC_DOCUMENTS, [
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
  assert.deepEqual(GENERATED_DIAGRAMS, [
    "docs/assets/architecture-mobile.svg",
    "docs/assets/architecture.svg",
    "docs/assets/lifecycle-mobile.svg",
    "docs/assets/lifecycle.svg",
    "docs/assets/loop-mobile.svg",
    "docs/assets/loop.svg",
  ]);
  assert.ok(CHECKED_SOURCE_PATHS.includes("packages/core/src/agent-contract.ts"));
  assert.ok(CHECKED_SOURCE_PATHS.includes("agent/crates/agent-service/src/protocol.rs"));
  assert.ok(CHECKED_SOURCE_PATHS.includes("packages/core/src/learner-loop-contract.json"));

  const result = checkPublicContract();
  assert.deepEqual(result.drift, [], `unexpected drift: ${JSON.stringify(result.drift, null, 2)}`);
});

test("a reviewed false or stale claim in any owned document fails --check", () => {
  const mutations = [
    {
      id: "readme_study_modes",
      why: "README claims a study mode the mounted product does not send",
      mutate: (documents) => {
        documents["README.md"] = documents["README.md"].replace(
          /^\| \*\*One mode.*$/m,
          "| **Four modes, one loop** | `quiz`, `teach`, `mock`, and `cram` change the pressure. |",
        );
      },
    },
    {
      id: "readme_pdf_ingestion",
      why: "README claims PDF extraction while the agent fails PDFs closed",
      mutate: (documents) => {
        documents["README.md"] += "\nA student uploads a PDF and Viva reads every page.\n";
      },
    },
    {
      id: "readme_scheduling_authority",
      why: "README names `packages/core` as scheduling authority",
      mutate: (documents) => {
        documents["README.md"] += "\nScheduling authority lives in `packages/core`.\n";
      },
    },
    {
      id: "tool_surface",
      why: "a doc names a retired tool as a shipped capability",
      mutate: (documents) => {
        documents["README.md"] +=
          "\n`mark_concept_status` records the concept while the call runs.\n";
      },
    },
    {
      id: "protocol_version",
      why: "a doc or diagram advertises the retired v4 wire",
      mutate: (documents) => {
        documents["docs/assets/architecture.svg"] = documents[
          "docs/assets/architecture.svg"
        ].replace("protocol v5", "protocol v4");
      },
    },
    {
      id: "audio_lifecycle_frame_cap",
      why: "docs omit the actual audio lifecycle/frame cap",
      mutate: (documents) => {
        documents["README.md"] = documents["README.md"].replaceAll("8,192", "some");
      },
    },
    {
      id: "security_controls_scope",
      why: "SECURITY.md measures a report against a control the tree does not ship",
      mutate: (documents) => {
        documents["SECURITY.md"] = documents["SECURITY.md"].replaceAll(
          "VIVA_VOICE_WS_TRUSTED_PROXY_CIDRS",
          "the leftmost X-Forwarded-For hop",
        );
      },
    },
    {
      id: "durable_postgres_continuity",
      why: "docs call optional/manual Postgres proof continuous",
      mutate: (documents) => {
        documents["CONTRIBUTING.md"] = documents["CONTRIBUTING.md"].replaceAll(
          "Durable Postgres proof",
          "an optional local Postgres run",
        );
      },
    },
    {
      id: "domain_purity_scope",
      why: "docs say the domain purity gate enforces I/O boundaries when it does not",
      mutate: (documents) => {
        documents["CONTRIBUTING.md"] += "\nThe purity gate proves the domain performs no I/O.\n";
      },
    },
    {
      id: "deletion_policy_text",
      why: "docs describe a deletion policy the selected branch does not run",
      mutate: (documents) => {
        documents["docs/data-governance.md"] = documents["docs/data-governance.md"].replaceAll(
          "hard_purge_text",
          "soft_tombstone",
        );
      },
    },
    {
      id: "disclosure_scope",
      why: "docs scope the disclosure to microphone audio only",
      mutate: (documents) => {
        documents["docs/data-governance.md"] = documents["docs/data-governance.md"].replaceAll(
          "all_live_provider_content",
          "microphone_audio_only",
        );
      },
    },
    {
      id: "deploy_binding_verification",
      why: "deployment docs omit exact deploy SHA/run ID/HMAC verification",
      mutate: (documents) => {
        documents["docs/deployment-runbook.md"] = documents[
          "docs/deployment-runbook.md"
        ].replaceAll("hmac-sha256", "some signature");
      },
    },
    {
      id: "learner_loop_contract_fields",
      why: "`docs/learner-loop-contract.md` omits fields from the canonical JSON",
      mutate: (documents) => {
        documents["docs/learner-loop-contract.md"] = documents[
          "docs/learner-loop-contract.md"
        ].replace(/^- `budget_state`$/m, "");
      },
    },
    {
      id: "diagram_removed_names",
      why: "diagram files name removed providers, stores, routes, or authority edges",
      mutate: (documents) => {
        documents["docs/assets/lifecycle.svg"] = documents["docs/assets/lifecycle.svg"].replace(
          "</svg>",
          "<text>schedule_review_item</text></svg>",
        );
      },
    },
    {
      id: "requirements_vision_label",
      why: "`docs/REQUIREMENTS.md` fails to label vision separately from current behavior",
      mutate: (documents) => {
        documents["docs/REQUIREMENTS.md"] = documents["docs/REQUIREMENTS.md"].replace(
          /^> \*\*Status:.*$/m,
          "",
        );
      },
    },
    {
      id: "static_export_claim",
      why: "D-06B deleted the static export; no document may claim it",
      mutate: (documents) => {
        documents["CONTRIBUTING.md"] += "\nRun the static export build before opening a PR.\n";
      },
    },
    {
      id: "release_readiness_status_emitted",
      why: "no pre-freeze document may emit a terminal release status",
      mutate: (documents) => {
        documents["docs/release-readiness.md"] += "\n- Terminal status: RELEASE_READY\n";
      },
    },
  ];

  for (const mutation of mutations) {
    const result = checkWith(mutation.mutate);
    assertDrift(result, mutation.id);
  }

  // Every drift id the checker can raise has a mutation control somewhere in
  // this file; `public_contract_stale` has its own test below because it mutates
  // the generated artifact rather than a document.
  const raised = new Set([...mutations.map((mutation) => mutation.id), "public_contract_stale"]);
  for (const id of checkPublicContract().known_drift_ids) {
    assert.ok(raised.has(id), `drift id \`${id}\` has no mutation control`);
  }
});

test("a stale tracked contract is drift, not a silent overwrite", () => {
  const stale = JSON.parse(readFileSync(PUBLIC_CONTRACT_PATH, "utf8"));
  stale.study_modes = ["quiz", "cram"];

  const result = checkPublicContract({
    generatedContractText: `${JSON.stringify(stale, null, 2)}\n`,
  });
  assertDrift(result, "public_contract_stale");
});

test("evidence binds to the frozen SHA and refuses to write PASS over drift", () => {
  const evidence = buildDocsContractEvidence({ frozenSha: FROZEN_SHA_FIXTURE });

  assert.equal(evidence.schema, PUBLIC_CONTRACT_EVIDENCE_SCHEMA);
  assert.equal(evidence.frozen_sha, FROZEN_SHA_FIXTURE);
  assert.equal(evidence.status, "PASS");
  assert.equal(evidence.drift_count, 0);
  assert.equal(evidence.sanitized, true);
  assert.match(evidence.source_manifest_sha256, /^[0-9a-f]{64}$/);
  assert.match(evidence.public_contract_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    Object.keys(evidence.document_sha256).sort(),
    [...OWNED_PUBLIC_DOCUMENTS, ...GENERATED_DIAGRAMS].sort(),
  );
  for (const digest of Object.values(evidence.document_sha256)) {
    assert.match(digest, /^[0-9a-f]{64}$/);
  }
  assert.deepEqual(evidence.checked_source_paths, CHECKED_SOURCE_PATHS);

  assert.throws(
    () => buildDocsContractEvidence({ frozenSha: "not-a-sha" }),
    /frozen sha/i,
    "a malformed frozen SHA must never reach an evidence file",
  );

  assert.throws(
    () =>
      buildDocsContractEvidence({
        frozenSha: FROZEN_SHA_FIXTURE,
        documents: (() => {
          const documents = documentsFromDisk();
          documents["README.md"] += "\nScheduling authority lives in `packages/core`.\n";
          return documents;
        })(),
      }),
    /drift/i,
    "evidence must exit non-zero rather than record PASS over drift",
  );
});

test("the CLI checks, writes, and refuses evidence without a frozen SHA", () => {
  const check = spawnSync(process.execPath, ["scripts/public-contract.mjs", "--check"], {
    encoding: "utf8",
  });
  assert.equal(check.status, 0, check.stderr);

  const missingSha = spawnSync(
    process.execPath,
    ["scripts/public-contract.mjs", "--evidence", "--output", "artifacts/unused.json"],
    { encoding: "utf8" },
  );
  assert.notEqual(missingSha.status, 0);
  assert.match(`${missingSha.stderr}${missingSha.stdout}`, /--frozen-sha/);

  const workspace = mkdtempSync(path.join(tmpdir(), "viva-public-contract-"));
  try {
    for (const relativePath of [
      ...CHECKED_SOURCE_PATHS,
      ...OWNED_PUBLIC_DOCUMENTS,
      ...GENERATED_DIAGRAMS,
      PUBLIC_CONTRACT_PATH,
    ]) {
      const destination = path.join(workspace, relativePath);
      mkdirSync(path.dirname(destination), { recursive: true });
      cpSync(relativePath, destination, { recursive: true });
    }

    const clean = spawnSync(
      process.execPath,
      [path.resolve("scripts/public-contract.mjs"), "--check", "--root", workspace],
      { encoding: "utf8" },
    );
    assert.equal(clean.status, 0, clean.stderr);

    const readmePath = path.join(workspace, "README.md");
    writeFileSync(
      readmePath,
      `${readFileSync(readmePath, "utf8")}\nScheduling authority lives in \`packages/core\`.\n`,
    );

    const dirty = spawnSync(
      process.execPath,
      [path.resolve("scripts/public-contract.mjs"), "--check", "--root", workspace],
      { encoding: "utf8" },
    );
    assert.notEqual(dirty.status, 0);
    assert.match(`${dirty.stderr}${dirty.stdout}`, /readme_scheduling_authority/);

    const evidenceOutput = path.join(workspace, "docs-contract.json");
    const evidence = spawnSync(
      process.execPath,
      [
        path.resolve("scripts/public-contract.mjs"),
        "--evidence",
        "--frozen-sha",
        FROZEN_SHA_FIXTURE,
        "--output",
        evidenceOutput,
        "--root",
        workspace,
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(evidence.status, 0, "drift must block evidence generation");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
