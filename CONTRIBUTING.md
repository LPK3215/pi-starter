# Contributing to pi-starter

Thanks for your interest in improving pi-starter! This guide covers everything you need to make a change locally and open a pull request.

## Table of contents

- [Prerequisites](#prerequisites)
- [Development setup](#development-setup)
- [Project layout](#project-layout)
- [Making changes](#making-changes)
- [Testing, typechecking, building](#testing-typechecking-building)
- [Commit & PR conventions](#commit--pr-conventions)
- [Reporting issues](#reporting-issues)

## Prerequisites

- **Node.js ≥ 22.19** — required by `package.json` (`engines.node`). The project uses the built-in `node:sqlite`, so older Node will fail.
- **npm** (bundled with Node) — the only package manager used by this repo.
- An API key from a provider you can test with (ModelScope by default, see `.env.example`).

## Development setup

```bash
git clone https://github.com/LPK3215/pi-starter.git
cd pi-starter
npm install
cp .env.example .env    # Windows: copy .env.example .env
# edit .env and fill in PI_API_KEY, PI_MODEL, etc.
npm run setup           # merges credentials into ~/.pi/agent/
```

## Project layout

See the [Project Structure](README.md#project-structure) section of the README for a map of `src/`. The short version:

- Business logic and examples: `src/tools/`, `src/skills/`, `src/knowledge/`, `src/extensions/`, `src/memory/`
- Assembly layer: `src/agent.ts` (model + prompts + tools + extensions)
- Turn engine and session stack: `src/conversation/` → `src/session-hub.ts` / `src/client-session.ts` → `src/snapshot.ts` / `src/protocol.ts` → `src/transport/ws.ts`
- HTTP layer: `src/app.ts` (wiring) + `src/http/` (the route modules: `routes.ts`, `file-routes.ts`, `approval-routes.ts`, `provider-key-routes.ts`, `log-routes.ts`, `hardening.ts`, `rate-limit.ts`) + `src/sse.ts` (SSE protocol)
- Shared config: `src/config.ts` (CLI > `.env` > defaults)
- Library entry: `src/lib.ts` — exports `buildAgent`, `createApp`, `setupPiAgentDir` (not `setup`)

## Making changes

1. **Sync from upstream** and create a topic branch:

   ```bash
   git checkout main
   git pull
   git checkout -b feat/<short-topic>   # or fix/, refactor/, docs/, chore/
   ```

2. **Keep changes scoped.** Do not edit `node_modules/@earendil-works`. Do not add new runtime dependencies unless the feature genuinely needs them.

3. **Update tests with code.** The contract smoke tests (`*.test.ts` under `src/`) must never call a real model or touch the real `~/.pi/agent/` — keep them runnable offline. Two rules that exist because they were broken in practice:
   - **Temp directories go through `tempDir()`** (`src/test-tmp.ts`), not a bare `mkdtempSync`. Test files used to leak 8.5k directories (~165 MB) into the system temp folder because nothing deleted them. `tempDir()` registers cleanup on process exit and reports removal failures instead of swallowing them.
   - **Platform-inapplicable assertions call `t.skip(reason)` and return.** Never `catch { return; }` — a test that never ran an assertion must not show up as a pass. Skips are printed and counted (see the Windows notes in the table below).

4. **Update docs.** If you add a tool, endpoint, config key, or event, update `README.md` **and** `README.zh-CN.md` side by side so the two stay aligned. The generated surfaces are not edited by hand — run `npm run docs:svg && npm run docs:numbers && npm run docs:reference && npm run docs:overview`; `npm run docs:check` fails if you forget. `docs/参考手册.md` and `docs/project_overview/` are the two places that enumerate routes: add a route to `API_GROUPS` in `scripts/visualization/generate_overview.mjs` or the build stops, because a route that matches no group silently disappears from the page.

5. **Self-check** before opening a PR (same gates as CI):

   ```bash
   npm run verify   # typecheck + lint:unused + test + test:web + docs:check + verify:audit + smoke + build + verify:embed
   npm run verify:all   # the above + npm run e2e (real processes; see the platform note below)
   # or run them individually:
   npm run typecheck
   npm run lint:unused
   npm test
   npm run test:web
   npm run docs:check
   npm run verify:audit
   npm run build
   ```

## Testing, typechecking, building

| Command | What it does |
|---|---|
| `npm test` | Runs the smoke suite under `src/` with `tsx --test` |
| `npm run typecheck` | Runs `tsc --noEmit` against `tsconfig.json` |
| `npm run build` | Cleans `dist/`, compiles via `tsconfig.build.json`, copies prompt / skill / knowledge assets |
| `npm run dev` | Starts the interactive CLI (needs a working `.env` + `npm run setup`) |
| `npm run web` | Starts the HTTP + SSE server on `:3000` |
| `npm run rag:smoke` | Optional live check of the local in-process vector RAG (`@huggingface/transformers`); prints `SKIP` + exit 0 when the model host / native runtime is unreachable, so it never false-greens or blocks you |
| `npm run clean` | Removes `dist/` |
| `npm run test:web` | Frontend contract tests (`web/src/pi/*.test.ts`), headless, `fetch` stubbed |
| `npm run test:coverage` | Coverage ratchet via Node's built-in `--experimental-test-coverage` (no c8/nyc). Thresholds live in `scripts/coverage-thresholds.mjs` (the only copy — the overview page reads them from there) and only ever move **up**, measured over `src/**` only |
| `npm run docs:check` | Byte-compares every generated surface against source: `docs:numbers:check` (README tables) + `docs:reference:check` (`docs/参考手册.md`) + `docs:svg:check` (the three diagrams) + `docs:overview:check` (`docs/project_overview/`, including the exportable `project_card.html`). Drift exits 1 and names the regeneration command; a broken assertion (route in the table that no longer exists, missing `src/` directory in the structure tree, dead local reference) exits 2 and blocks the write |
| `npm run docs:svg` / `docs:numbers` / `docs:reference` / `docs:overview` | Regenerate the diagrams / README numbers / reference manual / overview page |
| `npm run verify:audit` | Runs the **same** dependency-audit commands the remote gate runs (root package + `web/`), so "green locally" and "green remotely" mean the same thing. Three outcomes are kept apart: pass / advisories found / **could not execute** (exit 2 — a broken gate is never reported as a pass, nor as a vulnerability) |
| `npm run smoke` | Real HTTP + WS transport checks (frame order, pending replay, origin, backpressure) without a model |
| `npm run e2e` | Real processes: full turn → `SIGKILL` → restart → conversation recovered from disk (plus tool-call recovery, settings persistence, no ghost index entries, port released on shutdown) |
| `npm run probe:providers` | Live reachability check of the providers configured in `.env` |

**Platform note.** The gate that actually fires is `.cnb.yml`: a single `node:24` Linux container. `.github/workflows/ci.yml` declares a three-OS matrix (ubuntu / windows / macos on Node 22.19 / 22.x / 24.x) but **does not run for this account** (Actions is blocked by billing), so "CI is green" means CNB, and a Windows-only failure is invisible to it. Anything newly added to `verify` must therefore be run locally on Windows before it is called green — and `docs:overview:check` already bit that rule once: it passed locally and failed remotely because `git ls-files` escapes non-ASCII paths under git's default `core.quotePath`. On Windows the suite reports explicit skips with reasons: file-permission assertions (`chmod` can only set the read-only bit, so `0600` and `0644` are indistinguishable in `stat.mode`), file symlinks (need developer mode / privileges; junctions only work for directories), and the real-`SIGTERM` shutdown path (`child.kill` goes through `TerminateProcess`) — that last one is why the graceful-shutdown **orchestration** lives in `src/graceful.ts` with all-platform tests instead of being left unwatched.

## Commit & PR conventions

- **One logical change per commit.** Write messages in imperative mood, e.g. `add refund skill example`, not `added stuff`.
- **Reference issues** in the PR body (`Fixes #123`) when applicable.
- **Include a short description** of *what* and *why*, plus how you verified the change.
- **Breaking changes** (public API of `buildAgent` / `createApp`, CLI flags, `.env` keys, HTTP contract) need an explicit note and a version bump proposal.
- Maintainers squash-merge PRs by default to keep history linear.

## Reporting issues

Open a [GitHub issue](https://github.com/LPK3215/pi-starter/issues) with:

- Node version and OS
- The relevant `.env` values (redact all secrets before posting)
- Exact command and output
- For crashes: the full stack trace
- For unexpected behavior: what you expected vs. what happened, and which tier of built-in tools you were on (`off` / `readonly` / `coding`)

Security issues are handled differently — please see [SECURITY.md](SECURITY.md).
