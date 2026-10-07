/**
 * pi-starter · 命令行参数
 *
 * CLI 和 Web 入口共用同一套 flag，避免两处各写一份 indexOf。
 */

export interface CliFlags {
  provider?: string;
  model?: string;
  builtinTools?: string;
  port?: number;
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

export function parseCliFlags(argv: string[]): CliFlags {
  const portRaw = flagValue(argv, "--port");
  const port = portRaw === undefined ? undefined : Number(portRaw);
  return {
    provider: flagValue(argv, "--provider"),
    model: flagValue(argv, "--model"),
    builtinTools: flagValue(argv, "--builtin-tools"),
    port: port !== undefined && Number.isFinite(port) ? port : undefined,
  };
}
