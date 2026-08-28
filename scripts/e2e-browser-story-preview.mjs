// RELEASE-030 E2E extraction, further split (post-review-remediation amend):
// the D-09 Branch B harness-authored structured-preview fixture. Derived
// from `e2e-browser-story.mjs`. A pure string template; no imports.

export function pendingPreviewHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Viva browser story pending preview</title>
    <style>
      :root {
        color-scheme: light;
        --ink: #17211b;
        --muted: #5e6c62;
        --paper: #f7f2e8;
        --line: #cbbf9e;
        --accent: #327066;
        --panel: #fffaf0;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        min-height: 900px;
        background:
          linear-gradient(90deg, rgba(50, 112, 102, 0.16) 0 1px, transparent 1px 100%),
          linear-gradient(180deg, rgba(203, 191, 158, 0.55) 0 1px, transparent 1px 100%),
          var(--paper);
        background-size: 72px 100%, 100% 36px;
        color: var(--ink);
        font-family:
          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        width: min(1120px, calc(100vw - 96px));
        margin: 68px auto;
      }
      .eyebrow {
        color: var(--accent);
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      h1 {
        margin: 16px 0 12px;
        max-width: 760px;
        font-size: 56px;
        line-height: 1.02;
        letter-spacing: 0;
      }
      .lede {
        max-width: 690px;
        color: var(--muted);
        font-size: 20px;
        line-height: 1.45;
      }
      .manuscript {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 300px;
        gap: 32px;
        align-items: start;
        margin-top: 54px;
      }
      .sheet,
      aside {
        border: 1px solid var(--line);
        background: rgba(255, 250, 240, 0.82);
        box-shadow: 0 20px 48px rgba(53, 44, 27, 0.12);
      }
      .sheet {
        min-height: 430px;
        padding: 42px 48px;
      }
      .row {
        display: grid;
        grid-template-columns: 140px minmax(0, 1fr);
        gap: 28px;
        padding: 20px 0;
        border-bottom: 1px solid rgba(203, 191, 158, 0.7);
      }
      .row:last-child {
        border-bottom: 0;
      }
      .label {
        color: var(--accent);
        font-size: 14px;
        font-weight: 700;
      }
      .value {
        font-size: 24px;
        line-height: 1.28;
      }
      aside {
        padding: 28px;
      }
      aside h2 {
        margin: 0 0 18px;
        font-size: 20px;
        letter-spacing: 0;
      }
      .status {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        border: 1px solid rgba(50, 112, 102, 0.34);
        padding: 10px 12px;
        color: var(--accent);
        font-weight: 700;
      }
      .dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--accent);
      }
      ul {
        margin: 22px 0 0;
        padding-left: 20px;
        color: var(--muted);
        line-height: 1.65;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="eyebrow">Listening Manuscript browser story</div>
      <h1>Local preview pending</h1>
      <p class="lede">
        Sanitized preview frame for a manuscript set before server readiness. It includes only
        structural state and contains no learner payload.
      </p>
      <section class="manuscript" aria-label="Pending local preview">
        <div class="sheet">
          <div class="row">
            <div class="label">Set state</div>
            <div class="value">Extraction pending</div>
          </div>
          <div class="row">
            <div class="label">Session</div>
            <div class="value">The Conductor waits for a server-ready study set.</div>
          </div>
          <div class="row">
            <div class="label">Evidence</div>
            <div class="value">Browser-rendered structured preview, no live provider, no microphone.</div>
          </div>
        </div>
        <aside>
          <h2>Audit boundary</h2>
          <div class="status"><span class="dot" aria-hidden="true"></span>Sanitized</div>
          <ul>
            <li>No raw media</li>
            <li>No learner response</li>
            <li>No prompts</li>
            <li>No full notes</li>
          </ul>
        </aside>
      </section>
    </main>
  </body>
</html>`;
}
