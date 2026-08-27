import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(path) {
  return JSON.parse(await readFile(join(root, path), "utf8"));
}

function build(entry, outfile) {
  const result = spawnSync(
    "bun",
    ["build", entry, "--target=browser", "--minify", "--outfile", outfile],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

test("@viva/core exports have exact TypeScript-path parity and no wildcard", async () => {
  const corePackage = await readJson("packages/core/package.json");
  const tsconfig = await readJson("tsconfig.base.json");
  const expectedExports = {
    ".": "./src/index.ts",
    "./fixtures": "./src/fixtures.ts",
    "./runtime-validation": "./src/runtime-validation.ts",
    "./testing/fake-evaluator": "./src/testing/fake-evaluator.ts",
  };
  const expectedPaths = {
    "@viva/core": ["packages/core/src/index.ts"],
    "@viva/core/fixtures": ["packages/core/src/fixtures.ts"],
    "@viva/core/runtime-validation": ["packages/core/src/runtime-validation.ts"],
    "@viva/core/testing/fake-evaluator": ["packages/core/src/testing/fake-evaluator.ts"],
  };

  assert.deepEqual(corePackage.exports, expectedExports);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(tsconfig.compilerOptions.paths).filter(([key]) =>
        key.startsWith("@viva/core"),
      ),
    ),
    expectedPaths,
  );
  assert.equal(
    Object.keys(corePackage.exports).some((key) => key.includes("*")),
    false,
  );
  assert.equal(
    Object.keys(tsconfig.compilerOptions.paths).some(
      (key) => key.startsWith("@viva/core") && key.includes("*"),
    ),
    false,
  );
});

test("@viva/core/runtime-validation is native Node pure ESM", () => {
  const probe = [
    'const runtimeValidation = await import("@viva/core/runtime-validation");',
    "const actual = Object.keys(runtimeValidation).sort();",
    "const expected = [",
    '  "VIVA_LEARNER_LOOP_CONTRACT",',
    '  "VIVA_LEARNER_LOOP_EVIDENCE_FIELDS",',
    '  "VIVA_LEARNER_LOOP_MAX_TURN_MS",',
    '  "VIVA_LEARNER_LOOP_TERMINAL_REASONS",',
    '  "VIVA_PRE_LOOP_TERMINAL_REASONS",',
    '  "VIVA_RUNTIME_COPY_CAUSES",',
    '  "parseVivaServerFrame",',
    '  "validateLearnerLoopContract",',
    "].sort();",
    "if (JSON.stringify(actual) !== JSON.stringify(expected)) process.exit(2);",
    'if (typeof runtimeValidation.parseVivaServerFrame !== "function") process.exit(3);',
    'if (typeof runtimeValidation.validateLearnerLoopContract !== "function") process.exit(4);',
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", probe],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("production browser entry excludes the deterministic fake evaluator", async (t) => {
  const tempDir = await mkdtemp(join(root, "apps/web/.package-build-contract-"));
  t.after(async () => rm(tempDir, { force: true, recursive: true }));

  const productionEntry = join(tempDir, "production-entry.ts");
  const productionBundle = join(tempDir, "production-bundle.js");
  const negativeControlEntry = join(tempDir, "fake-evaluator-entry.ts");
  const negativeControlBundle = join(tempDir, "fake-evaluator-bundle.js");

  await writeFile(
    productionEntry,
    [
      'import { createStudySetPreview } from "@viva/core";',
      'import { seedStudySets } from "@viva/core/fixtures";',
      "globalThis.__vivaPackageContract = [",
      '  createStudySetPreview({ pastedText: "cellular respiration" }).id,',
      "  seedStudySets[0]?.id,",
      "];",
    ].join("\n"),
  );
  await writeFile(
    negativeControlEntry,
    [
      'import { evaluateAnswer } from "@viva/core/testing/fake-evaluator";',
      'globalThis.__vivaFakeEvaluation = evaluateAnswer("36 ATP").retryPrompt;',
    ].join("\n"),
  );

  build(productionEntry, productionBundle);
  build(negativeControlEntry, negativeControlBundle);

  const production = await readFile(productionBundle, "utf8");
  const negativeControl = await readFile(negativeControlBundle, "utf8");
  const fakeOnlyText = "Try again using the phrase 'shuttle system'.";

  assert.doesNotMatch(production, new RegExp(fakeOnlyText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(negativeControl, new RegExp(fakeOnlyText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("@viva/ui-web receives React from its consumer", async () => {
  const uiPackage = await readJson("packages/ui-web/package.json");
  assert.equal(uiPackage.private, true);
  assert.deepEqual(uiPackage.exports, {
    ".": "./src/index.tsx",
    "./styles.css": "./src/styles.css",
  });
  assert.equal(uiPackage.dependencies?.["@viva/tokens"], "workspace:*");
  assert.equal(uiPackage.dependencies?.react, undefined);
  assert.equal(uiPackage.peerDependencies?.react, "^19.2.3");
  assert.equal(uiPackage.devDependencies?.react, "19.2.3");
});

test("mounted web tests use one exact DOM implementation", async () => {
  const webPackage = await readJson("apps/web/package.json");
  assert.equal(webPackage.devDependencies?.["happy-dom"], "20.11.6");
  assert.equal(webPackage.devDependencies?.["@happy-dom/global-registrator"], "20.11.6");
});

test("Turbo restores web build artifacts and hashes public build inputs", async () => {
  const rootPackage = await readJson("package.json");
  const turbo = await readJson("turbo.json");
  assert.equal(
    rootPackage.scripts?.["build:cache:prove"],
    "node scripts/prove-turbo-cache-restoration.mjs",
  );
  assert.equal(turbo.tasks.build.outputs.includes(".next/**"), true);
  assert.equal(turbo.tasks.build.outputs.includes("!.next/cache/**"), true);
  const requiredBuildEnv = [
    "NEXT_PUBLIC_VIVA_AGENT_HTTP_URL",
    "NEXT_PUBLIC_VIVA_AGENT_WS_URL",
    "NEXT_PUBLIC_VIVA_API_URL",
    "NEXT_PUBLIC_VIVA_VOICE_SESSION_TOKEN",
    "NEXT_PUBLIC_VIVA_VOICE_TRUSTED_SESSION_ID",
    "NEXT_PUBLIC_VIVA_VOICE_TRUSTED_STUDY_SET_ID",
    "NEXT_PUBLIC_VIVA_VOICE_TRUSTED_USER_ID",
  ];
  assert.equal(requiredBuildEnv.every((name) => turbo.tasks.build.env.includes(name)), true);
});

test("every Rust workspace package reports Apache-2.0", () => {
  const result = spawnSync(
    "cargo",
    ["metadata", "--format-version", "1", "--no-deps", "--manifest-path", "agent/Cargo.toml"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const metadata = JSON.parse(result.stdout);
  const workspaceMembers = new Set(metadata.workspace_members);
  const workspacePackages = metadata.packages.filter((pkg) => workspaceMembers.has(pkg.id));
  assert.equal(workspacePackages.length, 5);
  assert.deepEqual([...new Set(workspacePackages.map((pkg) => pkg.license))], ["Apache-2.0"]);
  assert.equal(
    workspacePackages.every((pkg) => Array.isArray(pkg.publish) && pkg.publish.length === 0),
    true,
  );
});

test("D-06 STATIC_EXPORT is either fully gated or fully deleted", async () => {
  const rootPackage = await readJson("package.json");
  const turbo = await readJson("turbo.json");
  const sourcePaths = [
    "apps/web/next.config.ts",
    "apps/web/lib/viva-agent-client.ts",
    "apps/web/lib/viva-agent-client.test.ts",
    "apps/web/lib/viva-library.ts",
    "apps/web/lib/viva-library.test.ts",
    "apps/web/app/page.tsx",
    "apps/web/components/landing/LandingEntry.test.tsx",
  ];
  const source = (
    await Promise.all(sourcePaths.map((path) => readFile(join(root, path), "utf8")))
  ).join("\n");
  const hasStaticFlag = /(?:NEXT_PUBLIC_)?VIVA_STATIC_EXPORT/.test(source);
  const baseBuildEnv = [
    "NEXT_PUBLIC_VIVA_AGENT_HTTP_URL",
    "NEXT_PUBLIC_VIVA_AGENT_WS_URL",
    "NEXT_PUBLIC_VIVA_API_URL",
    "NEXT_PUBLIC_VIVA_VOICE_SESSION_TOKEN",
    "NEXT_PUBLIC_VIVA_VOICE_TRUSTED_SESSION_ID",
    "NEXT_PUBLIC_VIVA_VOICE_TRUSTED_STUDY_SET_ID",
    "NEXT_PUBLIC_VIVA_VOICE_TRUSTED_USER_ID",
  ];

  if (hasStaticFlag) {
    assert.equal(
      rootPackage.scripts?.["build:static"],
      "VIVA_STATIC_EXPORT=1 NEXT_PUBLIC_VIVA_STATIC_EXPORT=1 turbo run build --filter=@viva/web",
    );
    assert.equal(
      rootPackage.scripts?.["e2e:static"],
      "node scripts/static-export-browser-gate.mjs",
    );
    assert.equal(turbo.tasks["build:static"], undefined);
    assert.deepEqual(turbo.tasks.build.env, [
      ...baseBuildEnv,
      "NEXT_PUBLIC_VIVA_STATIC_EXPORT",
      "VIVA_STATIC_EXPORT",
    ]);
    assert.deepEqual(turbo.tasks.build.outputs, [
      ".next/**",
      "!.next/cache/**",
      "out/**",
    ]);
  } else {
    assert.equal(rootPackage.scripts?.["build:static"], undefined);
    assert.equal(rootPackage.scripts?.["e2e:static"], undefined);
    assert.equal(turbo.tasks["build:static"], undefined);
    assert.deepEqual(turbo.tasks.build.env, baseBuildEnv);
    assert.deepEqual(turbo.tasks.build.outputs, [".next/**", "!.next/cache/**"]);
    assert.doesNotMatch(JSON.stringify(turbo), /(?:NEXT_PUBLIC_)?VIVA_STATIC_EXPORT/);
  }
});
