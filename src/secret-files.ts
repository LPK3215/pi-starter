/**
 * pi-starter · 敏感文件名策略（中性模块，多方共用）
 *
 * 这些文件名一旦被「读走」就等于凭据外泄，而它们**通常就躺在工作目录里**
 * （`.env` 在 cwd 根、`auth.json` 在 `~/.pi/agent`）。而项目里所有路径校验
 * （`FileService.assertRealpathInside`、`guard` 的 `isPathInsideCwd`）判的都是
 * 「在不在工作目录内」，对**文件名**完全无感知——于是 cwd 内的 `.env` 反而最危险。
 *
 * 所以这条策略必须被**所有**能读文件的入口共用：
 *   - HTTP 文件服务（`files/service.ts` 的 `denyNames`）；
 *   - agent 自己的 SDK 内置工具（`extensions/guard.ts` 的 `read` / `write` / `edit`）。
 *
 * 放在中性模块而不是 `files/service.ts`，是为了不让扩展层反向依赖 HTTP 文件服务。
 *
 * 这不是通用沙箱：只覆盖已知的凭据文件名，且可用 `denyNames` 覆盖。
 */

/**
 * 默认拒绝的名称（basename 匹配，支持前缀 `foo*` / 后缀 `*.pem` / 中缀 `*x*` / 精确名）。
 *
 * 具体列表见 `DEFAULT_DENY_NAMES`。
 */
export const DEFAULT_DENY_NAMES: readonly string[] = [
  ".env",
  ".env.*",
  ".npmrc",
  ".netrc",
  ".pgpass",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials",
  "credentials.json",
  "auth.json",
];

/** 单个名字是否命中拒绝名单（大小写不敏感；`*` 支持开头 / 结尾 / 两端）。 */
export function isDeniedName(
  name: string,
  denyNames: readonly string[] = DEFAULT_DENY_NAMES,
): boolean {
  const lower = name.toLowerCase();
  for (const pattern of denyNames) {
    const p = pattern.toLowerCase();
    if (p.startsWith("*") && p.endsWith("*")) {
      if (lower.includes(p.slice(1, -1))) return true;
    } else if (p.startsWith("*")) {
      if (lower.endsWith(p.slice(1))) return true;
    } else if (p.endsWith("*")) {
      if (lower.startsWith(p.slice(0, -1))) return true;
    } else if (lower === p) {
      return true;
    }
  }
  return false;
}
