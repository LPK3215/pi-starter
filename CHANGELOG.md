# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Open-source metadata** in `package.json`: `author`, `license: MIT`, `homepage`, `repository`, `bugs`, `keywords`, `main`, `types`, `files`; removed `private: true` so the package can be published or consumed as a library.
- **Bilingual README layout**: `README.md` is now the English main version; `README.zh-CN.md` is added as the Chinese companion. Both start with a language-switch line and share the same section structure.
- **Badges + repo URL** at the top of both READMEs (release, license, Node engine, CI status, issues, last commit, PRs welcome).
- **Architecture section** in both READMEs, referencing the two generated SVGs:
  - `docs/architecture.svg` — layered stack diagram (entry / assembly / business resources / HTTP+SSE / runtime+config).
  - `docs/sse-protocol.svg` — `POST /chat` sequence diagram with the live SSE event vocabulary and tool-result preview limit.
- **Diagram generators** under `scripts/visualization/`, Node built-ins only, all counts and names parsed from source:
  - `generate_architecture.mjs` reads `package.json`, `src/tools/*.ts`, `src/skills/*/SKILL.md`, `src/knowledge/*.md`, `src/extensions/index.ts`, `src/app.ts`, `src/sse.ts`, and every `src/**/*.test.ts`.
  - `generate_request_flow.mjs` parses `src/sse.ts` (event names, `TOOL_RESULT_PREVIEW_LIMIT`) and `src/app.ts` (SSE frames emitted outside the translator).
  - `README.md` documents the run command and single-source-of-truth rules.
- **Tech stack table** in both READMEs, sourced directly from `package.json`.
- **Standard OSS files**: `CONTRIBUTING.md`, `SECURITY.md`, `FAQ.md`, `AUTHORS`, `.gitattributes` (LF-normalised text, binary whitelist, `linguist-generated` for `package-lock.json` and `dist/**`), `.github/workflows/ci.yml` (matrix: ubuntu / windows / macos × Node 22.19 / 22.x / 24.x, runs typecheck + test + build, uploads `dist/` artifact).

### Changed

- **LICENSE** copyright holder updated to `LPK3215` (matches `git config user.name`).
- **README** project structure tree extended to show `docs/`, `scripts/visualization/`, and `.github/workflows/`.
- **.gitignore** supplemented with local env variants, SQLite artifacts, TypeScript / test caches, IDE folders, and OS junk files.

### Fixed

- Replaced broken internal reference to a private local tutorial path in the previous `README.md` with a link to the upstream [pi repository](https://github.com/earendil-works/pi).

## [0.1.0] - 2026-10-08

Initial public scaffold release.

### Added

- **Assembly layer** (`src/agent.ts`): combines model, layered prompts, tools, and extensions into a runnable agent session.
- **Config layer** (`src/config.ts`, `src/cli-args.ts`): CLI flag > `.env` > default resolution for provider, model, model catalog (`PI_MODELS`), API keys, built-in-tool tier (`PI_BUILTIN_TOOLS`), and database path.
- **Dual entry points**:
  - CLI (`src/index.ts`, `npm run dev`) with `/models` and `/model <id>` slash commands.
  - HTTP + SSE server (`src/server.ts` + `src/app.ts` + `src/sse.ts`, `npm run web`) exposing `/health`, `/skills`, `/skills/:name`, `/knowledge`, `/knowledge/search`, `/knowledge/:name`, `/db`, `/db/notes`, `/db/query`, `/model`, `/chat`.
- **Layered prompts**: `src/prompts/persona.md` and `src/prompts/rules.md` compose the system prompt.
- **Tool layer** with pluggable registration (`src/tools/index.ts`): built-in example `current_time`, plus `search_knowledge` / `read_knowledge` and `db_status` / `db_query`.
- **Skills** (`src/skills/`): `<name>/SKILL.md` loaded through the SDK's `DefaultResourceLoader.additionalSkillPaths`; the sample `summarize` skill ships with the repo.
- **Knowledge base** (`src/knowledge/`): scan-and-search Markdown store (SDK has no native knowledge base); `about.md` example included.
- **Database** (`src/db/`): Node 22 `node:sqlite` with an in-memory default, sample `notes` rows seeded at startup, `GET /db` liveness, and read-only `db_query`.
- **Extensions** (`src/extensions/`): `guard` (pre-execution interception of dangerous bash and paths escaping cwd, `read SKILL.md` excepted) and `audit` (per-tool timing logs).
- **One-command Pi setup** (`npm run setup`): merge-writes `~/.pi/agent/models.json` and `auth.json` (mode `0o600`) from `.env`; `--force` opts into overwriting existing keys.
- **Model catalog & runtime switching**: `PI_MODELS` supports multiple providers; switch models via `--model`, CLI `/model`, or `POST /model` without rebuilding the session.
- **Built-in-tool tiers**: `off` (default, custom tools + `read` for skills), `readonly` (adds `grep` / `find` / `ls`), `coding` (adds `bash` / `edit` / `write`). Local `~/.pi/agent/skills` and `~/.pi/agent/extensions` are not scanned by default.
- **Library export** (`src/lib.ts`): `import { buildAgent, createApp } from "pi-starter"` with `extraTools`, `extraExtensions`, `extraSkillPaths`, `extraKnowledgeDirs`, `database`, `databasePath`, `inMemory`, `staticDir` options.
- **Contract smoke tests** (`*.test.ts` under `src/`): run offline; do not call models or write to the real `~/.pi/agent/`.
- **Sample chat page** (`public/index.html`): local-only reference UI for trying the HTTP/SSE endpoints.
- **Build pipeline** (`npm run build`, `scripts/dist-assets.cjs`): compiles TypeScript to `dist/` and copies prompt / skill / knowledge assets alongside the emitted JS.

[Unreleased]: https://github.com/LPK3215/pi-starter/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/LPK3215/pi-starter/releases/tag/v0.1.0
