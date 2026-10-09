/**
 * pi-starter · 子进程环境裁剪
 *
 * `loadEnvFile()` 会把整个 `.env` 灌进 `process.env`（其中包含 `PI_API_KEY`）。若子进程直接
 * 继承 `process.env`，那么开启 `coding` 档之后，任何 `bash` / `exec` 命令、任何 MCP 子进程
 * 都能 `echo $PI_API_KEY` 把模型密钥读走——这与 `provider-keys.ts` 守的
 * 「原始 key 值及其任何派生形式永不出服务端」直接冲突。
 *
 * 所以凡是 spawn 子进程的地方都从这里取 env：剔除项目自己的密钥变量，其余（PATH / HOME /
 * 语言环境等）原样保留，否则 shell 与外部工具无法正常工作。
 *
 * 注意：MCP 服务器可能需要它自己的凭据，那是**调用方显式传入**的 `options.env`，
 * 不属于「继承宿主环境」的范畴，因此不在这里剔除（也不会被这里覆盖）。
 */

/** 需要从子进程环境中剔除的变量名前缀（大小写不敏感）。 */
const SECRET_ENV_PREFIXES = ["PI_API_KEY"] as const;

/** 变量名是否是项目自己的密钥（`PI_API_KEY` / `PI_API_KEY_<PROVIDER>`）。 */
export function isSecretEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return SECRET_ENV_PREFIXES.some((prefix) => upper === prefix || upper.startsWith(`${prefix}_`));
}

/** 供子进程继承的环境变量：`process.env` 的副本，剔除密钥变量。 */
export function childProcessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (isSecretEnvName(key)) continue;
    out[key] = value;
  }
  return out;
}
