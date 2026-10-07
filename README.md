# π-starter

[中文](README.zh-CN.md) | **English**

An **agent scaffold** built on the [pi-agent](https://github.com/earendil-works/pi) SDK: clone it and it runs; add tools, extensions, or a new persona, and it becomes a vertical agent.

## Features

- **Dual entry points**: CLI (`npm run dev`) + HTTP SSE (`npm run web`). The backend API is the product; `public/index.html` is only a local page for trying out the endpoints
- **Layered prompts**: `src/prompts/` holds `persona.md` (who the agent is) + `rules.md` (working constraints) — edit the files to change the personality
- **Pluggable tools**: define them under `src/tools/`, register in `tools/index.ts`, and they are auto-registered into the agent
- **Skill management**: `src/skills/<name>/SKILL.md`, loaded via the SDK's `DefaultResourceLoader.additionalSkillPaths`; the catalog is injected by `formatSkillsForPrompt` and full text is read by the built-in `read` tool through `<location>`
- **Knowledge base**: `src/knowledge/*.md` — the system prompt carries only the catalog; bodies are fetched on demand via `search_knowledge` / `read_knowledge` (the SDK has no native knowledge base)
- **Database**: Node's built-in `node:sqlite`, in-memory by default with sample `notes`; `GET /db` for liveness, `db_query` for read-only queries
- **Extensions**: hooks via `pi.on()` under `src/extensions/`. Ships with `guard` (pre-execution interception) and `audit` (timing logs)
- **One-command write into Pi native config**: `npm run setup` merges into `~/.pi/agent/models.json` + `auth.json`; no compatibility layer at runtime
- **Configurable, switchable model catalog**: `PI_MODELS` in `.env` declares multiple providers and models, `PI_MODEL` picks the default; switch mid-session with `/model` in the CLI or `POST /model` over HTTP — no session rebuild
- **Built-in coding tools off by default**: `off` enables only custom tools + `read` (skills need it); bash/edit/write must be turned on explicitly
- **Library export**: after `npm run build`, `import { buildAgent, createApp } from "pi-starter"` — inject business logic through parameters instead of editing scaffold sources

## Defaults

The scaffold is a **vertical-agent starting point**, not another coding-assistant wrapper. Right after cloning:

| Included | Excluded (unless you turn it on) |
|---|---|
| Custom tools registered in `src/tools/` (ready example: `current_time`) | SDK built-in `bash` / `edit` / `write` (`off` still enables `read`, for skills) |
| `src/skills/` via SDK `additionalSkillPaths`, full text loaded by the built-in `read` | Local `~/.pi/agent/skills`, Claude Code / Codex skill directories |
| `src/knowledge/` base + `search_knowledge` / `read_knowledge` | Vector stores / external RAG |
| In-memory SQLite + `GET /db` / `db_query` | Remote Postgres / connection pools (inject your own `database`) |
| `persona.md` + `rules.md` system prompt | File extensions from `~/.pi/agent/extensions` and `<cwd>/.pi/extensions` |
| `guard` intercepting dangerous bash and paths outside cwd (`read SKILL.md` excepted) | Full sandboxing / container isolation |
| `audit` printing tool durations | Login, multi-user sessions, public-internet exposure |
| CLI persists sessions to disk; HTTP keeps in-memory sessions with a single-user busy guard | |

Enable built-in tools (priority: CLI flags > `.env` > default `off`):

```bash
# .env
PI_BUILTIN_TOOLS=off        # default: custom tools + read (for skills)
# PI_BUILTIN_TOOLS=readonly # plus grep / find / ls
# PI_BUILTIN_TOOLS=coding   # plus bash / edit / write

# or a temporary override
npm run dev -- --builtin-tools coding
```

`readonly` / `coding` go through the SDK allowlist, and custom tool names are merged into it automatically. Tools must appear in `src/tools/index.ts` or `buildAgent({ extraTools })`; names registered only inside extensions are not allowlisted automatically.

With `coding` on, `guard` actually intercepts bash / write: dangerous commands (e.g. `rm -rf`) and paths outside the working directory are blocked with `{ block: true }`. Edit rules in `src/extensions/guard.ts`.

## Quick Start

### 0. Prerequisites

- Node.js ≥ 22.19
- A ModelScope token (or an API key from any OpenAI-compatible provider you switch to)

### 1. Install and write Pi config

```bash
npm install
cp .env.example .env   # Windows: copy .env.example .env
# edit .env, fill in PI_API_KEY
npm run setup
```

`setup` **merges** (never clobbers other providers) into the Pi native paths:

- `~/.pi/agent/models.json` — ModelScope `baseUrl` + model ids
- `~/.pi/agent/auth.json` — `{ "modelscope": { "type": "api_key", "key": "..." } }` (file mode 0o600)

Existing keys for a provider are kept by default. To overwrite, add `--force`:

```bash
npm run setup -- --force
```

The SDK still reads these two files at runtime; `PI_API_KEY` in `.env` is only consumed by setup and never sits in the request path.

The default model in `.env` can be written two ways:

```bash
PI_MODEL=modelscope/Qwen/Qwen3-Next-80B-A3B-Instruct
# or split (when the model id itself contains a slash, it is kept as-is and not parsed as a provider)
PI_PROVIDER=modelscope
PI_MODEL=Qwen/Qwen3-Next-80B-A3B-Instruct
```

If missing, startup throws — it does **not** fall back to the SDK's built-in huggingface.

For multiple models, write `PI_MODELS`: one provider per entry, models comma-separated, display names colon-separated:

```bash
PI_MODELS=modelscope|https://api-inference.modelscope.cn/v1|openai-completions|Qwen/Qwen3-Next-80B-A3B-Instruct:Qwen3-Next-80B,Qwen/Qwen2.5-72B-Instruct;zhipu|https://open.bigmodel.cn/api/paas/v4|openai-completions|glm-4.5-air:GLM-4.5-Air
```

Without `PI_MODELS`, setup uses only the single default entry, with the base URL from `PI_BASE_URL`.

Priority: **CLI `--model` / `--provider` > `.env`**. There is no third "SDK picks for you" tier.

Keys are per provider: the default provider uses `PI_API_KEY`, the rest use `PI_API_KEY_<PROVIDER>` (uppercase, e.g. `PI_API_KEY_ZHIPU`). A missing key for the default model's provider fails immediately; missing keys for other providers are skipped with a notice.

Hand-writing `~/.pi/agent/` also works, format:

```json
{
  "providers": {
    "modelscope": {
      "baseUrl": "https://api-inference.modelscope.cn/v1",
      "api": "openai-completions",
      "models": [
        { "id": "Qwen/Qwen3-Next-80B-A3B-Instruct", "name": "Qwen3-Next-80B" }
      ]
    }
  }
}
```

```json
{
  "modelscope": { "type": "api_key", "key": "ms-your-key" }
}
```

- `api`: use `openai-completions` for domestic / OpenAI-compatible vendors, `anthropic-messages` for Anthropic
- `baseUrl` goes **only up to `/v1`**; do not append `/chat/completions`

### 2. CLI chat

```bash
npm run dev
# temporarily switch the default model:
npm run dev -- --model zhipu/glm-4.5-air
# switch inside a session (not sent to the model):
#   /models
#   /model modelscope/Qwen/Qwen2.5-72B-Instruct
```

### 3. HTTP API (backend)

```bash
npm run web
# defaults to http://localhost:3000
```

`public/index.html` is only a local page for trying the endpoints, not a product frontend. When embedding into an existing service use `createApp({ staticDir: false })` and mount your own page.

`GET /health` returns the current model, the available model list, skill / knowledge catalogs, database liveness, the built-in-tools tier, and whether the agent is busy.

You can test resources without calling any model (virtual / sample data is enough):

```bash
curl http://localhost:3000/skills
curl http://localhost:3000/skills/summarize
curl http://localhost:3000/knowledge/search?q=model%20switching
curl http://localhost:3000/knowledge/about
curl http://localhost:3000/db
curl http://localhost:3000/db/notes
curl -X POST http://localhost:3000/db/query -H "content-type: application/json" -d "{\"sql\":\"SELECT title FROM notes\"}"
```

`POST /model` switches the model of the current session without rebuilding it:

```json
{ "model": "zhipu/glm-4.5-air" }
```

`POST /chat` is the exposed SSE protocol over HTTP (callable from any language):

| Event type | data | Meaning |
|---|---|---|
| `text` | `{delta}` | a chunk of the answer |
| `thinking` | `{delta}` | a chunk of the thinking |
| `tool_start` | `{id,name,args}` | tool execution started |
| `tool_end` | `{id,name,result,isError}` | tool execution finished |
| `done` | `{}` | stream fully ended |
| `error` | `{message}` | failure |

## Project Structure

```
pi-starter/
├── src/
│   ├── index.ts          # CLI entry (interactive chat)
│   ├── server.ts         # Web entry: parse args, listen
│   ├── app.ts            # ★ HTTP app: /health /skills /knowledge /db /model /chat
│   ├── lib.ts            # library export (buildAgent / createApp / setup)
│   ├── setup.ts          # npm run setup: merge-write into ~/.pi/agent/
│   ├── agent.ts          # ★ assembly: model + persona + tools + extensions → session
│   ├── config.ts         # config layer: CLI / .env / built-in-tools tier
│   ├── cli-args.ts       # CLI flag parsing (shared by CLI and Web)
│   ├── sse.ts            # agent events → SSE protocol
│   ├── prompts/          # layered prompts (edit here = change the persona)
│   │   ├── persona.md    #   who the agent is, how it answers
│   │   └── rules.md      #   working constraints
│   ├── tools/            # tool layer: give the LLM "hands"
│   │   ├── index.ts      #   ★ static tool registry
│   │   ├── current-time.ts
│   │   ├── knowledge.ts  #   search / read the knowledge base
│   │   └── database.ts   #   db_status / db_query
│   ├── skills/           # skills: <name>/SKILL.md, SDK additionalSkillPaths
│   │   ├── index.ts
│   │   └── summarize/SKILL.md
│   ├── knowledge/        # knowledge base: *.md, scanned at startup
│   │   ├── index.ts
│   │   └── about.md
│   ├── db/               # database: node:sqlite, in-memory + sample notes
│   │   └── index.ts
│   └── extensions/       # extension layer: hooks on agent lifecycle
│       ├── index.ts      #   ★ registry
│       ├── guard.ts      #   example: tool_call interception (dangerous bash / path escape)
│       └── audit.ts      #   example: tool-call audit log
└── public/
    └── index.html        # sample chat page (for trying endpoints, not a frontend)
```

Contract smoke tests (no model calls, never touch the real `~/.pi/agent`):

```bash
npm test
npm run typecheck
npm run build
```

## Secondary development: business comes in through the interface

The scaffold handles assembly, models, the guardrail, and HTTP. Business logic (tools, persona, pages, login) is injected from outside — do not modify `node_modules/@earendil-works`.

Two ways in:

1. **Edit this repo**: persona in `src/prompts/`, tools registered in `src/tools/index.ts`, skills dropped into `src/skills/`, knowledge into `src/knowledge/`, extensions registered in `src/extensions/index.ts`.
2. **Use it as a library**: after `npm run build`, `import { buildAgent, createApp } from "pi-starter"` and inject via parameters; the scaffold stays untouched.

```ts
import { buildAgent, createApp } from "pi-starter";

const agent = await buildAgent({
  systemPrompt: "You are a customer-service assistant...",
  extraTools: [myTool],
  extraExtensions: [myExtension],
  extraSkillPaths: ["./skills"],
  extraKnowledgeDirs: ["./docs"],
  databasePath: ":memory:",
  inMemory: true,
});
const { app, dispose } = createApp({ agent, staticDir: false });
// mount app onto your existing Express; login, multi-user, frontend are yours
```

`extraExtensions` run after the built-in `guard` / `audit`. `createApp({ staticDir: false })` exposes only the API. On name collisions, repo-bundled skills/knowledge take precedence over injected ones.

### Add a tool

```ts
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

export const myTool = defineTool({
  name: "my_tool",
  label: "My Tool",
  description: "One sentence on what this tool does (the LLM decides when to call it based on this)",
  parameters: Type.Object({
    query: Type.String({ description: "parameter description" }),
  }),
  async execute(_id, params: { query: string }) {
    return { content: [{ type: "text", text: `Result: ${params.query}` }], details: {} };
  },
});
```

In-repo: add it to `allTools` in `src/tools/index.ts`. As a library: pass it to `buildAgent({ extraTools: [myTool] })`. The `readonly` / `coding` tiers merge these names into the SDK allowlist.

### Add an extension

A runnable interception example already exists: `src/extensions/guard.ts`. Copy its structure for new extensions.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function myExtension(pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (event.toolName === "dangerous_tool") {
      return { block: true, reason: "this tool is not allowed" };
    }
    return undefined;
  });
}
```

In-repo: add it to `allExtensions` in `src/extensions/index.ts`. As a library: pass it to `buildAgent({ extraExtensions: [myExtension] })`.

### Add a skill

A skill is a `SKILL.md` with YAML frontmatter ([Agent Skills](https://agentskills.io/specification)). Loading goes through the SDK: `noSkills: true` disables scanning your local `~/.pi`, and `additionalSkillPaths` loads only repo / injected directories. The SDK writes `<available_skills>` (with `<location>`) into the system prompt, and the model reads the full text with the built-in `read` tool.

```
src/skills/refund/SKILL.md
```

```md
---
name: refund
description: Handles refund requests. Use when the user mentions refunds, returns, or order cancellation.
---

# Refund flow

1. Ask for the order number first
2. Call the business tool to check status
3. Decide refundability by policy
```

After restart it shows up in `GET /health` / `GET /skills`. When the model matches the description it `read`s the SKILL.md at `<location>`. As a library: `buildAgent({ extraSkillPaths: ["/path/to/skills"] })`.

By default `~/.pi/agent/skills` is not scanned. The `off` tier enables `read` (skills need it) but not bash/edit/write. `guard` blocks paths escaping cwd by default but allows `read` on SKILL.md.

### Add a knowledge document

```
src/knowledge/pricing.md
```

```md
---
title: Pricing
description: Plans, unit prices, billing cycles
---

Basic 99/month, Pro 299/month.
```

Restart and it is live. The model calls `search_knowledge({ query: "how much is Pro" })` first, then `read_knowledge({ name: "pricing" })`. As a library: `buildAgent({ extraKnowledgeDirs: ["/path/to/docs"] })`.

This is in-process Markdown search, not a vector store. For RAG, write your own tool and register it in `extraTools`.

### Attach a database

The SDK has no native database. The scaffold uses Node 22's `node:sqlite`, defaulting to `:memory:` with two sample `notes` rows written at startup. `GET /db` for liveness, `POST /db/query` runs SELECT only. Agent-side tools: `db_status` / `db_query`.

```ts
const agent = await buildAgent({
  databasePath: "./data/app.db", // or PI_DATABASE_PATH
});
```

To swap implementations: implement `DatabaseStore` and pass `buildAgent({ database: myStore })`. HTTP and tools depend only on this interface.

Testing without calling the model:

```bash
curl http://localhost:3000/db
curl http://localhost:3000/db/notes
curl -X POST http://localhost:3000/db/query \
  -H "content-type: application/json" \
  -d '{"sql":"SELECT id, title FROM notes"}'
```

### Common `pi.on` events

| Event | When | Capability |
|---|---|---|
| `tool_call` | before tool execution | intercept / rewrite args |
| `tool_result` | after tool execution | rewrite result |
| `context` | before sending to the LLM | inject messages (e.g. user preferences) |
| `input` | after receiving user input | rewrite / block input |
| `before_agent_start` | before a run starts | modify the system prompt |
| `agent_settled` | one prompt fully done | reliable completion signal |

See the pi-agent SDK upstream repository for the full event menu.

### Embed into existing modules / build your own frontend

Backend endpoints are listed below. Build your own page later; do not edit the sample HTML in the scaffold.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | current model, available list, skill / knowledge catalogs, DB liveness, busy flag |
| GET | `/skills` | skill catalog (no model call) |
| GET | `/skills/:name` | full SKILL.md |
| GET | `/knowledge` | knowledge catalog |
| GET | `/knowledge/search?q=` | keyword search |
| GET | `/knowledge/:name` | full document |
| GET | `/db` | sqlite liveness |
| GET | `/db/notes` | sample table |
| POST | `/db/query` | `{ "sql": "SELECT …" }`, read-only |
| POST | `/model` | `{ "model": "provider/modelId" }`, switch in current session |
| POST | `/chat` | `{ "message": "..." }`, response is an SSE stream |

When embedding into an existing Express app use `createApp({ agent, staticDir: false })`; do not open a second port. Wrap authentication with your existing middleware.

## Scope boundaries

The scaffold does the following; everything else is left to business code:

| Done on purpose | Deliberately not done |
|---|---|
| Model catalog, pick at startup, switch at runtime | Login / user system. A local tool needs none; when attaching to an existing backend, wrap with your existing auth |
| CLI + HTTP share one `buildAgent` | Multi-user, multi-session. One process = one session; a concurrent second round returns 429 |
| Repo skills via the SDK ResourceLoader; Markdown knowledge search; sqlite liveness + read-only query | Vector stores, external RAG, scanning local `~/.pi/agent/skills` |
| `guard` blocks dangerous bash and paths escaping cwd | Sandboxing. Regexes cannot stop command substitution, encoded bypasses, symlinks. Use containers for isolation |
| `noExtensions` / `noSkills`: local extensions and skills are not scanned | Public-internet exposure. It binds all interfaces by default, with no auth |
| Default `PI_BUILTIN_TOOLS=off` | Turning on `coding` hands disk edits and shell execution to the model |

Why coding tools are off by default while `read` stays on: the SDK's `createAgentSession()` enables `read` / `bash` / `edit` / `write` when no `tools` are passed. The scaffold is a vertical-agent starting point, so bash/edit/write must be enabled explicitly. But the SDK only writes the skill catalog into the system prompt when `selectedTools` contains `read`, and the model uses `read` to load SKILL.md — this is the official path; there is no separate `read_skill` wrapper.

Why local extensions and skills are not loaded: pi extensions/skills on your machine may re-register bash/write, or push unrelated workflows into this vertical agent.

`guard` is not a sandbox. Rules live in `src/extensions/guard.ts`; adjust `DANGEROUS_BASH_RULES` for your business.

## Advanced (business decides)

- **Login**: local desktop / CLI usage can live without it. When attaching to an existing backend, add middleware outside `createApp()`; do not modify the scaffold.
- **Multi-user**: one `buildAgent()` + independent session per user; do not reuse the current single `busy` flag.
- **Enable coding tools**: `PI_BUILTIN_TOOLS=coding` or `--builtin-tools coding`. Even then, `guard` still blocks dangerous bash and paths escaping cwd.
- **Model switching**: at startup `--model provider/modelId`; in CLI `/model`; over HTTP `POST /model`. Only models with configured keys are accepted, via `session.setModel`, no session rebuild.
- **Skills / knowledge / database**: skills into `src/skills/`; knowledge into `src/knowledge/`; the DB is in-memory by default, or set `PI_DATABASE_PATH` / pass `buildAgent({ database })`. For vector stores or remote SQL, write a tool and pass it through `extraTools`.

## License

Released under the [MIT License](LICENSE).
