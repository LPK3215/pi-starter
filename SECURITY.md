# Security Policy

pi-starter is a **local-first agent scaffold**. Its design already excludes several classes of risk (no login, no multi-user session, no public-internet exposure), but you still need to understand the residual risks before deploying.

## Supported versions

| Version | Supported |
|---|---|
| `main` (latest) | ✅ |
| `0.x` tags       | ⚠️ best-effort; upgrade to `main` for security fixes |
| Anything older   | ❌ |

Security patches are only applied forward — please upgrade before reporting.

## Reporting a vulnerability

**Do not open a public GitHub issue for security problems.**

Email **17538703215@163.com** with:

- A description of the issue and the affected version / commit
- Reproduction steps or proof of concept
- Potential impact and any suggested mitigation

The maintainer will acknowledge within **72 hours** and coordinate disclosure timing with you. Public disclosure is welcome after a fix is released, or 90 days after your initial report if no fix has shipped by then.

## Built-in protections

- **`guard` extension** (`src/extensions/guard.ts`) intercepts:
  - Dangerous bash patterns (e.g. `rm -rf /`, `mkfs`, `dd if=/dev/zero`)
  - Filesystem paths that escape the current working directory
  - Exception: `read` on `SKILL.md` is allowed, because SDK skill loading requires it
- **`auth.json` file mode** is set to `0o600` by `npm run setup`.
- **Local `~/.pi/agent/skills` and `~/.pi/agent/extensions` are not scanned** by default. Only repo-bundled and explicitly injected (`extraSkillPaths` / `extraExtensions`) resources are loaded, so unrelated user-level extensions cannot register `bash` / `write` behind your back.
- **Built-in coding tools are off by default** (`PI_BUILTIN_TOOLS=off`). Enabling `readonly` or `coding` is an explicit opt-in.

## What is *not* protected

Read this before running pi-starter anywhere but your own machine:

- **`guard` is not a sandbox.** Regex-based interception can be bypassed by command substitution, encoded payloads, symlinks, and other indirect paths. Use containers or a VM if you need isolation.
- **The HTTP server has no authentication.** `npm run web` binds `127.0.0.1` by default, so only local processes can reach it. Setting `PI_HOST` to a non-loopback address (e.g. `0.0.0.0`) makes it answer any client — startup logs a warning when you do. Do **not** expose `:3000` to the internet or a shared LAN without a reverse proxy in front (nginx / Caddy / Traefik) plus your own auth middleware. Note that auth middleware added after `createApp()` — or inside its `configure` hook — does **not** cover the kernel routes; mount `createApp(...).app` as a sub-app behind your auth instead (see [`docs/嵌入指南.md`](docs/嵌入指南.md)).
- **Single-user session.** One process holds one agent session, and concurrent `/chat` calls return 429. Multi-user deployments need one `buildAgent()` per user with an independent session.
- **`PI_BUILTIN_TOOLS=coding` hands disk edits and shell execution to the model.** Only enable this in environments where the model is trusted and the working directory is disposable.
- **SQL is read-only** (`POST /db/query` accepts `SELECT` only, `db_query` tool refuses writes) — but the DB file itself is a plain `node:sqlite` file; protect it with your OS's file permissions if you use `PI_DATABASE_PATH`.
- **API keys in `.env`** are only consumed by `npm run setup`; they are copied into `~/.pi/agent/auth.json` and are not otherwise read at runtime. Still, treat `.env` as a secret file — never commit it (`.gitignore` already excludes it).

## Dependencies

The scaffold depends on `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-coding-agent`. Vulnerabilities in those upstream packages are tracked in [the pi repository](https://github.com/earendil-works/pi) and should be reported there when clearly upstream-only.

## Attestation & verification

Releases are not currently signed. If you need signed artifacts, open an issue and we will discuss adding Sigstore / cosign support.
