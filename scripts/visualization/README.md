# Visualization scripts

Generators for the SVG diagrams referenced from the top-level READMEs. Every script reads truth from the repository at generation time (source files, `package.json`, etc.), so re-running them after a code change is enough to refresh the diagram — no manual number-editing.

## Scripts

| Script | Output | Reads |
|---|---|---|
| `generate_architecture.mjs` | `docs/architecture.svg` | `package.json`, `src/tools/*.ts`, `src/skills/*/SKILL.md`, `src/knowledge/*.md`, `src/extensions/index.ts`, `src/app.ts`, `src/sse.ts`, all `src/**/*.test.ts` |
| `generate_request_flow.mjs` | `docs/sse-protocol.svg` | `src/sse.ts` (event names + `TOOL_RESULT_PREVIEW_LIMIT`), `src/app.ts` (SSE frames emitted outside the translator, e.g. `done` / `error`) |
| `generate_retrieval.mjs` | `docs/knowledge-retrieval.svg` | `src/knowledge/retrieval.ts`, `src/knowledge/embeddings*.ts`, `src/knowledge/vector-store-sqlite.ts` (Retriever / EmbeddingProvider / VectorStore class names) |

## Run

All scripts use only Node.js built-ins (`node:fs`, `node:path`). From the repo root:

```bash
node scripts/visualization/generate_architecture.mjs
node scripts/visualization/generate_request_flow.mjs
node scripts/visualization/generate_retrieval.mjs
```

Each script prints the numbers it picked up so drift is visible in the terminal too.

## Conventions

- **One asset, one language.** SVG text nodes are always English (per repo doc policy). Chinese explanations live in the README figure caption. Both `README.md` and `README.zh-CN.md` reference the same file at the same relative path.
- **No hardcoded dynamic values.** Anything that could change with the code (version, dep list, endpoint count, tool names, SSE event names, test counts, `TOOL_RESULT_PREVIEW_LIMIT`, etc.) is parsed from source at generation time. Adding a hard-coded number to a generator is a bug.
- **Do not delete scripts.** New diagrams → new `generate_<name>.mjs` in this folder. Never overwrite an existing generator; fork it or extend it.
- **Output path.** Generated SVGs land in `docs/`. Scripts themselves never touch `docs/` outside their own file, so the folder is safe to keep under version control.
- **Runtime.** Node 22+ is fine (matches the repo's `engines.node`). If a future diagram needs image rasterisation, prefer `npx` one-shots over adding npm dependencies just to render pictures.
