# Visualization scripts

Generators for the derived documentation surfaces: the SVG diagrams referenced from the top-level READMEs, the README metric tables, `docs/参考手册.md`, and the `docs/project_overview/` page. Every script reads truth from the repository at generation time (source files, `package.json`, etc.), so re-running them after a code change is enough to refresh the output — no manual number-editing.

## Scripts

| Script | Output | Reads |
|---|---|---|
| `generate_architecture.mjs` | `docs/architecture.svg` | `package.json`, `src/tools/*.ts`, `src/skills/*/SKILL.md`, `src/knowledge/*.md`, `src/extensions/index.ts`, `src/app.ts`, `src/sse.ts`, `metrics.mjs` (test counts) |
| `generate_request_flow.mjs` | `docs/sse-protocol.svg` | `src/sse.ts` (event names + `TOOL_RESULT_PREVIEW_LIMIT`), `src/app.ts` (SSE frames emitted outside the translator, e.g. `done` / `error`) |
| `generate_retrieval.mjs` | `docs/knowledge-retrieval.svg` | `src/knowledge/retrieval.ts`, `src/knowledge/embeddings*.ts`, `src/knowledge/vector-store-sqlite.ts` (Retriever / EmbeddingProvider / VectorStore class names) |
| `generate_readme_numbers.mjs` | the `generated-numbers` table in `README.md` and `README.zh-CN.md` | `metrics.mjs` |
| `generate_reference.mjs` | `docs/参考手册.md` | `src/protocol.ts`, `src/http/*.ts`, `src/app.ts`, `src/tools/*`, `src/agent.ts`, `.env.example`, `package.json`; asserts the README `src/` tree against the filesystem |
| `generate_overview.mjs` | `docs/project_overview/index.html` + the `METRICS` block in `script.js` | `metrics.mjs`, `git ls-files`, the page itself (assertions) |
| `metrics.mjs` | — (shared module) | the counting rules behind every number shown to a human: file and line counts, test cases, route handlers, gate list, dep versions, coverage thresholds |

## Run

All scripts use only Node.js built-ins (`node:fs`, `node:path`). From the repo root:

```bash
node scripts/visualization/generate_architecture.mjs
node scripts/visualization/generate_request_flow.mjs
node scripts/visualization/generate_retrieval.mjs
node scripts/visualization/generate_overview.mjs
```

Each script prints the numbers it picked up so drift is visible in the terminal too, and each accepts `--check`
(same exit codes as `npm run docs:check`: `0` in sync, `1` stale, `2` structurally broken — a missing marker or a
failed assertion). Asserting is not optional: `generate_overview.mjs` refuses to write when a route in its table
does not exist in the code, because "regenerate first, notice later" is exactly how the page grew entries for
endpoints that were never implemented.

## Conventions

- **One asset, one language.** SVG text nodes are always English (per repo doc policy). Chinese explanations live in the README figure caption. Both `README.md` and `README.zh-CN.md` reference the same file at the same relative path. The overview page is English end to end (`<html lang="en">`), including its generated regions; the Chinese documents it links to keep their own filenames.
- **No hardcoded dynamic values.** Anything that could change with the code (version, dep list, endpoint count, tool names, SSE event names, test counts, `TOOL_RESULT_PREVIEW_LIMIT`, etc.) is parsed from source at generation time. Adding a hard-coded number to a generator is a bug.
- **Generated regions live inside hand-written files.** A generator only ever replaces text between its own `BEGIN`/`END` markers (HTML comments in markup, block comments in JS); everything else is prose owned by a human. Markers missing means exit 2, never "insert a copy somewhere".
- **No wall-clock timestamps in checked artifacts.** `generate_overview.mjs` rewrites `generatedAt` only when something else actually changed. A date that moves on every run makes `--check` fail for no reason, and a gate that cries wolf gets skipped.
- **Repo listings come from `git ls-files`, not `readdirSync`.** The working directory also holds `.env`, `logs/`, `dist/` and whatever scratch folder the current task left behind; a page about "what is in this project" must not print those. The call is pinned to `git -c core.quotePath=false ls-files -z`: git's default config escapes non-ASCII paths as octal, developer machines usually turn that off, and CI containers do not inherit anyone's gitconfig — so an unpinned call is green locally and red remotely. Measured: `docs:overview:check` failed on the CNB runner for exactly this reason while three local runs passed.
- **A failing check names what changed.** `generate_overview.mjs --check` prints the changed `METRICS` keys, the changed region names, and the first differing lines. "drift" with no detail is a gate that sends someone to reproduce the CI environment by hand.
- **Do not delete scripts.** New diagrams → new `generate_<name>.mjs` in this folder. Never overwrite an existing generator; fork it or extend it.
- **Output path.** Generated SVGs land in `docs/`; `generate_readme_numbers.mjs` and `generate_reference.mjs` write into the READMEs and `docs/参考手册.md`; `generate_overview.mjs` writes only inside `docs/project_overview/`. Nothing generated appears at the repository root.
- **Runtime.** Node 22+ is fine (matches the repo's `engines.node`). If a future diagram needs image rasterisation, prefer `npx` one-shots over adding npm dependencies just to render pictures.
