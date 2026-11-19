# Source and release hygiene

This is a **Firefox browser-extension source project** using an independently
running local Chat On Steroids study bridge. It is not a self-contained AI
model or a signed Firefox Add-ons store release.

## Source layout

| Directory | Purpose | Publish in source? |
|---|---|---|
| `src/` | Extension manifest, TypeScript, and SVG icon | Yes |
| `scripts/` | Reproducible build, development, packaging, release checks | Yes |
| `tests/` | Deterministic source tests | Yes |
| `docs/` | Release, privacy and dependency notes | Yes |
| `node_modules/` | Local pinned npm dependencies installed from lockfile | **No** |
| `dist/` | Generated unpacked extension and unsigned XPI | **No** |

The root `.gitignore` also blocks local secrets, browser/dev profiles, logs,
crash dumps, caches and temporary build files, including when the source is
eventually copied into its own Git repository. The root `.gitattributes`
normalizes text line endings for independent publication.

## Verify the exact source on Windows

```powershell
npm ci
npm run release:check
```

`release:check` does the TypeScript check, runs the Vitest suite, builds the
extension, validates the generated Firefox add-on with Mozilla's `web-ext`
lint, produces one canonical unsigned `.xpi` and reads back its four allowed
files byte-for-byte. It rejects unexpected packaged files, mismatched
package/manifest/bridge-protocol versions, and broadened permission or host lists.

The output is `dist/artifacts/spiffy-pearson-study-helper-<version>-unsigned.xpi`.
There is no second byte-identical `.zip` package. Generated output is
reproducible from unchanged source and should not be checked into Git.

## Before creating a public GitHub repository

- Review the source tree and exact tracked file list; do not include
  `node_modules`, `dist`, Firefox profiles, extension session state,
  screenshots, logs, user questions, tokens, or CoS private data.
- Decide a **license explicitly**. No public license has been granted by
  simply creating this source checkout. Do not publish proprietary Pearson
  assets or other third-party code.
- Explain that Chat On Steroids is an **external private runtime dependency**.
  Publishing this extension does not provide an installable working study
  bridge or automatically authorize use against an educational site.
- Check the site's current rules and user permissions. Never auto-submit final
  assignments. The existing guarded practice controls are not a claim of
  approval from Pearson.
- Perform a real Firefox + Pearson practice assignment + local bridge
  acceptance run if the user authorizes that test. Tests and a clean XPI are
  **not** proof that all live Pearson DOM variations or browser installs work.
- Treat signing, installation, public GitHub upload, and any Firefox Add-ons
  distribution as separate explicit actions requiring review.

**Last verified:** The private archive handoff contains the original dated
implementation context and test evidence; this public source intentionally
does not include private `AI_MASTER_PROMPT.md` or its local paths. Re-run
`release:check` for current build results before any future release.
No live user profile was modified by the archive/organization pass.
