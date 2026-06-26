import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("validate workflow publishes the sanitized release evidence bundle", async () => {
  const workflow = await readFile(".github/workflows/validate.yml", "utf8");

  assert.match(workflow, /Browser synthetic manuscript E2E gate/);
  assert.match(workflow, /VIVA_E2E_AGENT_PROVIDER: synthetic/);
  assert.match(workflow, /VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO: "1"/);
  assert.match(workflow, /Continuous redaction control gate/);
  assert.match(
    workflow,
    /VIVA_REDACTION_BASE_REF: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.before \|\| 'origin\/main' \}\}/,
  );
  assert.match(workflow, /bun run redaction:check/);
  assert.match(workflow, /uses: actions\/upload-artifact@v4/);
  assert.match(workflow, /name: viva-release-evidence-\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /artifacts\/release-check\/evidence\.json/);
  assert.match(workflow, /artifacts\/release-check\/\*\.stdout\.log/);
  assert.match(workflow, /artifacts\/release-check\/\*\.stderr\.log/);
  assert.match(workflow, /artifacts\/e2e-browser\/browser-story\.json/);
  assert.match(workflow, /artifacts\/e2e-browser\/result\.json/);
  assert.match(workflow, /artifacts\/e2e-browser\/\*\.png/);
  assert.doesNotMatch(workflow, /trace\.zip/);
});
