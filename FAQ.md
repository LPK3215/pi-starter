# FAQ

Common questions encountered while setting up, running, and extending pi-starter. Answers are grounded in the actual code paths.

## Setup & configuration

### Why does startup throw with "missing PI_MODEL" instead of falling back to a default?

Because there is deliberately **no third tier of fallback** beyond CLI > `.env`. The SDK's built-in default (`huggingface`) does not match most vertical-agent use cases, and a silently-wrong model is worse than a loud failure at startup. Set `PI_MODEL` in `.env` (or pass `--model` on the CLI) — see the [Quick Start](README.md#quick-start) section.

### Can I put provider + model in one variable?

Yes. `PI_MODEL=modelscope/Qwen/Qwen3-Next-80B-A3B-Instruct` (recommended, one variable says it all) or split as `PI_PROVIDER` + `PI_MODEL`. Slashes inside the model id (e.g. `Qwen/Qwen3-…`) are preserved and are **not** reparsed as a provider.

### How do I add a second provider (e.g. zhipu alongside modelscope)?

Use `PI_MODELS`. Format: one entry per provider, fields separated by `|`, models comma-separated, optional `:displayName` per model, entries separated by `;`. Then add the key as `PI_API_KEY_<PROVIDER>` (uppercase):

```bash
PI_MODELS=modelscope|https://api-inference.modelscope.cn/v1|openai-completions|Qwen/Qwen3-Next-80B-A3B-Instruct:Qwen3-Next-80B;zhipu|https://open.bigmodel.cn/api/paas/v4|openai-completions|glm-4.5-air:GLM-4.5-Air
PI_API_KEY=ms-...
PI_API_KEY_ZHIPU=...
```

Only the default provider's key is mandatory; missing keys on other providers are skipped with a warning.

### Why doesn't my `.env` multi-line `PI_MODELS` work?

dotenv does not support continuation lines. Keep all entries on one physical line.

### Where are my API keys actually stored?

`npm run setup` merges them into `~/.pi/agent/auth.json` (mode `0o600`). Runtime requests read from that file via the SDK. `PI_API_KEY` in `.env` is only consumed by `setup` and never sits in the request path — you can safely delete it from `.env` after running `setup` if you want.

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

No. `guard` is regex-based pre-execution interception (see `src/extensions/guard.ts`); it stops `rm -rf`, `mkfs`, `dd of=`, fork bombs, shutdown/reboot, Windows destructive commands, and paths escaping cwd — but it is bypassable by command substitution, encoded payloads, symlinks, and other indirect tricks. For real isolation, run the whole thing in a container.

### `~/.pi/agent/skills` on my machine is being ignored. Is that a bug?

It's intentional. The scaffold sets `noSkills: true` and `noExtensions: true` so unrelated user-level skills and extensions cannot leak into a vertical agent. Only repo-bundled skills (`src/skills/`) and any paths you pass via `buildAgent({ extraSkillPaths })` / `{ extraExtensions }` are loaded.

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

Turn off `staticDir` so the sample `public/index.html` isn't mounted, and remember to call `dispose()` on shutdown to release the SQLite handle.

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

## Meta

### Why is the model tier `off` the default?

pi-starter is a **vertical-agent scaffold**, not a coding assistant. Coding tools are opt-in because they change the trust profile of the whole process (disk writes, shell execution).

### Which upstream SDK does this target?

`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` — pinned in `package.json`. See [the pi repository](https://github.com/earendil-works/pi) for the underlying event menu, tool contract, and extension API.
