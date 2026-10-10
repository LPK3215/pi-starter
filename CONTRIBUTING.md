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

- Business logic and examples: `src/tools/`, `src/skills/`, `src/knowledge/`, `src/extensions/`
- Assembly layer: `src/agent.ts` (model + prompts + tools + extensions)
- HTTP layer: `src/app.ts` (endpoints) + `src/sse.ts` (SSE protocol)
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

3. **Update tests with code.** The contract smoke tests (`*.test.ts` under `src/`) must never call a real model or touch the real `~/.pi/agent/` — keep them runnable offline.

4. **Update docs.** If you add a tool, endpoint, config key, or event, update `README.md` **and** `README.zh-CN.md` side by side so the two stay aligned.

5. **Self-check** before opening a PR (same gates as CI):

   ```bash
   npm run verify   # typecheck + lint:unused + test + test:web + smoke + build + verify:embed
   # or run them individually:
   npm run typecheck
   npm run lint:unused
   npm test
   npm run test:web
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
