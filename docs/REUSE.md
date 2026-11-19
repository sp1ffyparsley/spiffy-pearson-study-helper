# Reusable patterns from the Pearson study helper

This project is archived. Its original browser-extension architecture can
be studied without running or restoring the old Pearson-specific workflow.

## Broadly reusable pieces

| Source | Pattern | Reuse caution |
|---|---|---|
| `src/background/index.ts` | Bounded task queue, frame selection, screenshot/response lifecycle, stop/abort and safe diagnostics | Remove all Pearson-specific selectors, grading and answer-filling behavior for another product |
| `src/background/bridge.ts` | Loopback capability negotiation, per-extension pairing, timeout and retry classification | The server is **not** included here; avoid copying private tokens or coupling clients to an old CoS implementation |
| `src/shared/history.ts` | Bounded temporary conversation history with a serial mutation queue | Define a privacy lifecycle suited to the new use case; avoid persisting text/screenshot content |
| `src/shared/question.ts` | Assignment-scoped stable context key and parsing helpers | Replace assignment identifiers and site-specific parsing with new domain models |
| `src/shared/protocol.ts` | Typed messages, image limits and response constraints | Create a versioned contract for the new app instead of silently reusing the Pearson bridge protocol |
| `scripts/build.mjs`, `scripts/package.mjs`, `scripts/verify-release.mjs` | Bounded, reproducible Firefox build with strict packaging allowlist | New projects should explicitly review permissions, host allowlists and bundled files |

## Reuse checklist

1. Define the authorized target workflow and its privacy/consent boundary.
2. Reimplement the domain-specific interaction layer rather than porting
   academic answer-filling and grading behavior unchanged.
3. Keep screenshot capture opt-in, scoped and ephemeral, with content-free
   diagnostics and no private browser profiles or credential uploads.
4. Use your own runtime API/version identity and new permission allowlist.
5. Run unit, browser, installation and real-workflow tests before considering
   an extracted module production-ready. This archive does not prove a new
   adaptation will work.

The original source has **no public reuse license** at this time. Project
ownership and dependency rights must be resolved before copying or distributing
substantial code elsewhere.
