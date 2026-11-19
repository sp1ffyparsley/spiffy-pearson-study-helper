# Spiffy Pearson Study Helper

> **Archived source project.** This repository preserves an experimental Firefox
> extension, not a maintained browser add-on, an official Pearson integration,
> or a stand-alone ChatGPT service. It was developed for permitted personal
> practice and requires an independently installed, local Chat On Steroids
> study bridge. Do not use it to bypass course rules or submit assessed work.
> The old project was paused on November 18, 2026.

**Rights and publication:** source visibility on GitHub does not grant a
license to redistribute or incorporate this code. A reuse/license decision
must be made separately; all external dependencies retain their own licenses.
No private AI prompt history, browser profile, tokens, screenshots, or user
answers are included in this public source.

See [architecture reuse notes](docs/REUSE.md) for components that could be
adapted to other Firefox/screenshot workflows.

**Source layout:** `src/` contains the extension; `scripts/` owns build,
packaging and checks; `tests/` contains source tests; `docs/` contains
release guidance. `node_modules/` and `dist/` are generated and ignored
by this folder's own `.gitignore`, even outside the SS Scripts monorepo.

For a single release-readiness command, run `npm ci` once and then
`npm run release:check`. See [docs/RELEASE.md](docs/RELEASE.md) for the
source-publication boundary, current verification gates and privacy limits.

Firefox study helper for Pearson/MyLab/MathXL practice work. It captures the question as rendered pixels, sends up to four bounded WebP screenshots through the local Chat On Steroids bridge, keeps the same ChatGPT helper conversation across an assignment, and shows the returned answer/reasoning in a compact panel.

## Daily flow

1. Keep Chat On Steroids running with the study bridge build installed.
2. Open the Pearson assignment in Firefox.
3. Click the extension toolbar button or **Run All** in the on-page panel. It captures the rendered question, sends the screenshots through Chat On Steroids, parses the structured answer, fills the matching Pearson field/choice, clicks a safe **Check Answer** control, and advances only after a clear correct result.
4. Run All retries a clear wrong result up to two times using the same assignment ChatGPT conversation, then stops for review. It stops immediately when confidence is low, context is missing, a graph/drawing task is detected, no field can be matched, feedback is ambiguous, or a safe control is unavailable.
5. Click **Stop** at any time. The run is bounded to 25 practice questions and never clicks Finish, Submit, Grade, Complete, Turn In, or any other final-submission control.
6. **Ask only** keeps the one-question/manual workflow. **Wrong → Retry**, **Copy answer**, **Back**, and **Next / Skip** remain available for manual control.

If a request fails, open the extension's background console in `about:debugging` and filter for `[Spiffy Pearson]`. The log records frame detection, screenshot capture, bridge discovery/pairing, counts, and the failure stage without logging the question, answer, fill value, token, prompt, response, or image contents.

Retry context is bounded to the 16 most recent questions and three attempts per question, with at most 2,400 response characters per attempt. It is stored in Firefox session storage, disappears when the browser session ends, and can be erased immediately with **Clear retry history** in the on-page panel. An older `questionHistory.v1` value from a previous build is migrated into session storage and removed from persistent local storage. The local bridge pairing token remains persistent so Chat On Steroids does not need to pair again.

Interactive graph/drawing/drag tasks are intentionally stopped when ChatGPT identifies them or the capture is insufficient. The helper fills practice answers and may click Check Answer/Next only inside the bounded Run All workflow; it does not submit, finish, grade, complete, or turn in work.

## Why this is an extension

The older `MathXL Problem Solver — Economy Gemini-6.6.0.user.js` can inspect page text and images but a Tampermonkey userscript cannot reliably own Firefox's privileged rendered-tab capture. This extension uses `browser.tabs.captureVisibleTab`, so embedded images, MathJax, canvas content, and other rendered question pixels reach ChatGPT even when copying page text would miss them. If Pearson's DOM detector is inconclusive, the extension now captures the rendered document instead of stopping before the screenshot step.

Question detection reuses the proven Pearson selectors and scoring ideas from the old userscript. Tiled screenshot capture follows the bounded, scroll-and-restore pattern already used by Spiffy Scholarship Helper. The two existing projects are left unchanged.

## Build and test

```powershell
npm ci
npm run check
npm run lint:addon
npm run package
```

Outputs:

- unpacked Firefox build: `dist\firefox`
- unsigned package: `dist\artifacts\spiffy-pearson-study-helper-0.1.0-unsigned.xpi`

Packaging uses sorted paths and fixed ZIP metadata, prints the SHA-256, and is byte-reproducible from unchanged source.
The only distributable generated by `npm run package` is the unsigned
`.xpi`. The previous second `.zip` was byte-identical, unused and has been
retired to avoid producing duplicate packages.

For development, use the shared launcher:

In a standalone clone, use `npm run dev:firefox` after `npm ci`.
The following shared launcher only exists when this project is still inside
the original SS Scripts monorepo; it is **not** distributed by this repository:

```powershell
powershell -ExecutionPolicy Bypass -File "..\launchers\Firefox-Extension-Dev.ps1" -Project Pearson
```

It launches a temporary Firefox development profile, rebuilds on source changes, and lets `web-ext` reload the changed output. It does not modify the daily Firefox profile.

## Chat On Steroids contract

The extension discovers `127.0.0.1:8765-8769` and uses only:

- `GET /study-helper/hello`
- `POST /study-helper/pair`
- `POST /study-helper/ask`

Study-helper pairing accepts only a Firefox `moz-extension://` origin and uses its own encrypted `studyHelperBridgeToken`. It cannot rotate or authenticate with the normal Chrome companion token. The ask route validates 1-4 WebP images, holds the request while the existing ChatGPT decision-helper transport runs, and returns the assistant response. The bridge remembers the exact ChatGPT conversation per bounded Pearson assignment key so later parts continue in the same chat.

The Firefox side compresses every screenshot under 370,000 data-URL characters so four screenshots plus prompt stay below the local bridge's 2 MiB request cap.

## Run All diagnostics

Open the extension's background console in `about:debugging` and filter for `[Spiffy Pearson]`. Automation logs include frame detection, capture, fill count, clicked action, retry count, completion count, and the stop reason. Question text, answers, fill values, model responses, images, tokens, and prompts are not written to the diagnostic log.
