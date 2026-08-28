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

test("workspace package exports have exact TypeScript-path parity and no wildcard", async () => {
  const tsconfig = await readJson("tsconfig.base.json");
  const paths = tsconfig.compilerOptions.paths;

  // PACKAGE-03 covers every workspace package's exports map, not only
  // @viva/core: @viva/ui-web and @viva/tokens each publish a CSS subpath
  // export (./styles.css, ./theme.css) that must have an equally exact
  // tsconfig.base.json paths entry, or a wildcard-free compiler could
  // still diverge silently from the runtime export map.
  const packages = [
    {
      name: "@viva/core",
      manifestPath: "packages/core/package.json",
      expectedExports: {
        ".": "./src/index.ts",
        "./fixtures": "./src/fixtures.ts",
        "./runtime-validation": "./src/runtime-validation.ts",
        "./testing/fake-evaluator": "./src/testing/fake-evaluator.ts",
      },
      expectedPaths: {
        "@viva/core": ["packages/core/src/index.ts"],
        "@viva/core/fixtures": ["packages/core/src/fixtures.ts"],
        "@viva/core/runtime-validation": ["packages/core/src/runtime-validation.ts"],
        "@viva/core/testing/fake-evaluator": ["packages/core/src/testing/fake-evaluator.ts"],
      },
    },
    {
      name: "@viva/ui-web",
      manifestPath: "packages/ui-web/package.json",
      expectedExports: {
        ".": "./src/index.tsx",
        "./styles.css": "./src/styles.css",
      },
      expectedPaths: {
        "@viva/ui-web": ["packages/ui-web/src/index.tsx"],
        "@viva/ui-web/styles.css": ["packages/ui-web/src/styles.css"],
      },
    },
    {
      name: "@viva/tokens",
      manifestPath: "packages/tokens/package.json",
      expectedExports: {
        ".": "./src/index.ts",
        "./theme.css": "./src/theme.css",
      },
      expectedPaths: {
        "@viva/tokens": ["packages/tokens/src/index.ts"],
        "@viva/tokens/theme.css": ["packages/tokens/src/theme.css"],
      },
    },
  ];

  for (const { name, manifestPath, expectedExports, expectedPaths } of packages) {
    const manifest = await readJson(manifestPath);
    assert.deepEqual(manifest.exports, expectedExports, `${name} package.json exports`);
    const ownPaths = Object.fromEntries(
      Object.entries(paths).filter(([key]) => key === name || key.startsWith(`${name}/`)),
    );
    assert.deepEqual(ownPaths, expectedPaths, `${name} tsconfig.base.json paths`);
    assert.equal(
      Object.keys(manifest.exports).some((key) => key.includes("*")),
      false,
      `${name} package.json exports must not use a wildcard`,
    );
  }

  assert.equal(
    Object.keys(paths).some((key) => key.startsWith("@viva/") && key.includes("*")),
    false,
    "no @viva/* tsconfig.base.json path may use a wildcard",
  );
});

test("allowed package imports resolve, and forbidden deep imports fail, identically under the package export map and TypeScript paths", async () => {
  const fixturesRoot = "scripts/fixtures/package-import-parity";
  const allowed = [
    ["@viva/core", "allowed/core-root.ts", "packages/core/src/index.ts"],
    ["@viva/core/fixtures", "allowed/core-fixtures.ts", "packages/core/src/fixtures.ts"],
    [
      "@viva/core/runtime-validation",
      "allowed/core-runtime-validation.ts",
      "packages/core/src/runtime-validation.ts",
    ],
    [
      "@viva/core/testing/fake-evaluator",
      "allowed/core-testing-fake-evaluator.ts",
      "packages/core/src/testing/fake-evaluator.ts",
    ],
    ["@viva/ui-web", "allowed/ui-web-root.ts", "packages/ui-web/src/index.tsx"],
    ["@viva/tokens", "allowed/tokens-root.ts", "packages/tokens/src/index.ts"],
  ];
  const forbidden = [
    // packages/core/src/scheduling.ts is real but published only through
    // the aggregated "." root; this is architecture-consistency Minor 7's
    // own illustrative deep import.
    ["@viva/core/scheduling", "forbidden/core-scheduling.ts"],
    ["@viva/ui-web/index", "forbidden/ui-web-index.ts"],
    ["@viva/tokens/index", "forbidden/tokens-index.ts"],
  ];

  // Every fixture file must literally import the specifier it claims to, so
  // the TypeScript-world check (tsc against these exact files, below) and
  // the runtime-world check (further below) are driven by one fixture, not
  // two independently-maintained specifier lists.
  for (const [specifier, relPath] of [
    ...allowed.map(([specifier, relPath]) => [specifier, relPath]),
    ...forbidden,
  ]) {
    const source = await readFile(join(root, fixturesRoot, relPath), "utf8");
    const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(source, new RegExp(`from "${escaped}"`), `${relPath} must import "${specifier}"`);
  }

  // World 1: TypeScript path aliases. Allowed fixtures typecheck clean;
  // forbidden fixtures each fail to resolve.
  const tscBin = join(root, "node_modules/.bin/tsc");
  const allowedTsc = spawnSync(
    tscBin,
    ["--noEmit", "--project", join(fixturesRoot, "tsconfig.allowed.json")],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(allowedTsc.status, 0, `${allowedTsc.stdout}\n${allowedTsc.stderr}`);

  const forbiddenTsc = spawnSync(
    tscBin,
    ["--noEmit", "--project", join(fixturesRoot, "tsconfig.forbidden.json")],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(forbiddenTsc.status, 0, "forbidden deep imports must fail to typecheck");
  for (const [specifier] of forbidden) {
    const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(forbiddenTsc.stdout, new RegExp(`Cannot find module '${escaped}'`));
  }

  // World 2: the package export map, resolved the way Node/Bun/bundlers
  // actually resolve a bare specifier for a real consumer — via
  // Bun.resolveSync from apps/web, the one workspace location that links
  // all three packages. node:test runs under Node, which has no Bun
  // global, so this half runs in a spawned bun subprocess; the allowed
  // side also asserts the resolved file is the exact same file
  // tsconfig.base.json's paths entry names, i.e. that both worlds do not
  // merely agree pass/fail but resolve identically.
  const probe = [
    "const fromDir = process.argv[1];",
    "const allowed = JSON.parse(process.argv[2]);",
    "const forbidden = JSON.parse(process.argv[3]);",
    "const mismatches = [];",
    "for (const [specifier, expectedAbs] of allowed) {",
    "  try {",
    "    const resolved = Bun.resolveSync(specifier, fromDir);",
    "    if (resolved !== expectedAbs) {",
    "      mismatches.push(`${specifier} resolved to ${resolved}, expected ${expectedAbs}`);",
    "    }",
    "  } catch (error) {",
    "    mismatches.push(`${specifier} should resolve but threw: ${error.message}`);",
    "  }",
    "}",
    "for (const specifier of forbidden) {",
    "  try {",
    "    const resolved = Bun.resolveSync(specifier, fromDir);",
    "    mismatches.push(`${specifier} should be forbidden but resolved to ${resolved}`);",
    "  } catch {}",
    "}",
    "if (mismatches.length > 0) {",
    "  console.error(mismatches.join('\\n'));",
    "  process.exit(1);",
    "}",
  ].join("\n");

  const allowedForBun = allowed.map(([specifier, , expectedRelPath]) => [
    specifier,
    join(root, expectedRelPath),
  ]);
  const forbiddenForBun = forbidden.map(([specifier]) => specifier);

  const bunResult = spawnSync(
    "bun",
    ["-e", probe, join(root, "apps/web"), JSON.stringify(allowedForBun), JSON.stringify(forbiddenForBun)],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(bunResult.status, 0, `${bunResult.stdout}\n${bunResult.stderr}`);
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
