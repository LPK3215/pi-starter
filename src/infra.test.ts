/**
 * 生产化基础设施的回归测试：结构化日志 / 指标 / HTTP 加固。
 *
 * 这三块是「长期运行」的前提，出错的典型形态都是**静默失效**（日志不脱敏、
 * 指标恒为 0、body 无上限），因此必须用断言锁住。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Logger, isSecretKey, resolveLogLevel, sanitizeFields } from "./log.js";
import { Metrics } from "./metrics.js";
import { childProcessEnv, isSecretEnvName } from "./child-env.js";
import { isClientMessage } from "./protocol.js";
import { AppError, badRequest, clientErrorMessage } from "./errors.js";
import { DEFAULT_DENY_NAMES, isDeniedName } from "./secret-files.js";
import {
  DEFAULT_SECURITY_HEADERS,
  DEFAULT_TIMEOUTS,
} from "./http/hardening.js";

/** 建一个把输出收集到数组的 logger。 */
function capture(level: "debug" | "info" | "warn" | "error" | "silent") {
  const lines: string[] = [];
  return { lines, logger: new Logger({ level, sink: (line) => lines.push(line) }) };
}

/* ─────────────────── 日志：脱敏 ─────────────────── */

test("敏感字段一律打码，非敏感字段原样保留", () => {
  const { lines, logger } = capture("debug");
  logger.info("auth", {
    apiKey: "sk-SECRET",
    authorization: "Bearer x",
    password: "hunter2",
    model: "gpt",
    path: "/tmp/a",
  });
  const rec = JSON.parse(lines[0]!);
  assert.equal(rec.apiKey, "[redacted]");
  assert.equal(rec.authorization, "[redacted]");
  assert.equal(rec.password, "[redacted]");
  assert.equal(rec.model, "gpt", "non-secret must survive");
  assert.equal(rec.path, "/tmp/a");
});

test("嵌套对象里的密钥同样脱敏（不能只查顶层）", () => {
  const { lines, logger } = capture("debug");
  logger.info("cfg", { nested: { deep: { token: "t-1" } }, creds: ["ok"] });
  const rec = JSON.parse(lines[0]!);
  assert.equal(rec.nested.deep.token, "[redacted]");
  assert.equal(rec.creds[0], "ok");
});

test("isSecretKey 大小写与命名风格都要命中", () => {
  for (const key of ["apiKey", "API_KEY", "Authorization", "AUTH_HEADER", "accessToken", "password", "secret"]) {
    assert.equal(isSecretKey(key), true, `must redact ${key}`);
  }
  for (const key of ["model", "path", "cwd", "title"]) {
    assert.equal(isSecretKey(key), false, `must not redact ${key}`);
  }
});

test("超长字符串被截断，避免整段提示词/响应进日志", () => {
  const { lines, logger } = capture("debug");
  logger.info("big", { detail: "x".repeat(5000) });
  const rec = JSON.parse(lines[0]!);
  assert.ok((rec.detail as string).length < 5000);
  assert.match(rec.detail as string, /truncated/);
});

test("Error 必须保留 name/message/stack/cause，而不是序列化成 {}", () => {
  const { lines, logger } = capture("debug");
  const cause = new Error("root cause");
  logger.error("failed", { err: new Error("wrapper", { cause }) });
  const rec = JSON.parse(lines[0]!);
  // Regression guard: Error's own props are non-enumerable, so a naive spread yields `{}`
  // and the log loses the entire diagnostic value.
  assert.ok(Object.keys(rec.err).length > 1, "Error must not serialize to {}");
  assert.equal(rec.err.name, "Error");
  assert.equal(rec.err.message, "wrapper");
  assert.equal(rec.err.cause.message, "root cause");
  assert.match(rec.err.stack, /Error/);
});

/* ─────────────────── 日志：级别与派生 ─────────────────── */

test("级别过滤：低于阈值不输出", () => {
  const info = capture("info");
  info.logger.debug("d");
  info.logger.info("i");
  info.logger.warn("w");
  info.logger.error("e");
  assert.equal(info.lines.length, 3, "debug must be dropped at info level");

  const silent = capture("silent");
  silent.logger.error("e");
  assert.equal(silent.lines.length, 0);

  const debug = capture("debug");
  debug.logger.debug("d");
  assert.equal(debug.lines.length, 1);
});

test("级别可运行时调整（配置热更新）", () => {
  const { lines, logger } = capture("error");
  logger.info("hidden");
  logger.setLevel("debug");
  logger.debug("shown");
  assert.equal(lines.length, 1);
  assert.equal(logger.getLevel(), "debug");
});

test("child logger 继承级别并合并固定字段", () => {
  const { lines, logger } = capture("warn");
  const child = logger.child({ component: "guard" });
  child.info("hidden");
  child.warn("shown");
  assert.equal(lines.length, 1, "child must inherit the parent level");
  assert.equal(JSON.parse(lines[0]!).component, "guard");
});

test("resolveLogLevel 非法值回落 info", () => {
  assert.equal(resolveLogLevel({ PI_LOG_LEVEL: "debug" }), "debug");
  assert.equal(resolveLogLevel({ PI_LOG_LEVEL: "nonsense" }), "info");
  assert.equal(resolveLogLevel({}), "info");
});

test("sanitizeFields 深度受限，循环引用不会打爆栈", () => {
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  const out = sanitizeFields(cyclic as Record<string, unknown>);
  assert.ok(out.self !== undefined, "must terminate instead of recursing forever");
});

/* ─────────────────── 指标 ─────────────────── */

test("counter 只增不减，gauge 可正负调整但不为负", () => {
  const m = new Metrics();
  m.inc("toolCallsTotal");
  m.inc("toolCallsTotal", 3);
  assert.equal(m.get("toolCallsTotal"), 4);
  m.inc("toolCallsTotal", -5);
  assert.equal(m.get("toolCallsTotal"), 4, "counter must be monotonic");

  m.addGauge("wsConnections", 2);
  assert.equal(m.get("wsConnections"), 2);
  m.addGauge("wsConnections", -5);
  assert.equal(m.get("wsConnections"), 0, "gauge must not go negative");
});

test("未初始化指标读作 0 而非 undefined", () => {
  const m = new Metrics();
  assert.equal(m.get("protocolErrorsTotal"), 0);
  assert.equal(m.snapshot().pi_protocol_errors_total, 0);
});

test("Prometheus 输出含 HELP/TYPE 且 gauge 与 counter 类型正确", () => {
  const m = new Metrics();
  m.inc("promptsTotal", 2);
  m.setGauge("conversations", 3);
  const text = m.toPrometheus();
  assert.match(text, /# HELP pi_prompts_total/);
  assert.match(text, /# TYPE pi_prompts_total counter/);
  assert.match(text, /# TYPE pi_conversations gauge/);
  assert.match(text, /^pi_prompts_total 2$/m);
  assert.match(text, /^pi_conversations 3$/m);
  assert.match(text, /pi_uptime_seconds \d+/);
});

test("运行时信息含 uptime / node 版本 / pid", () => {
  const info = Metrics.runtimeInfo();
  assert.equal(typeof info.uptimeSeconds, "number");
  assert.equal(info.nodeVersion, process.version);
  assert.equal(info.pid, process.pid);
});

/* ─────────────────── HTTP 加固配置 ─────────────────── */

test("安全头默认值覆盖关键风险且不含放行型指令", () => {
  assert.equal(DEFAULT_SECURITY_HEADERS["X-Content-Type-Options"], "nosniff");
  assert.equal(DEFAULT_SECURITY_HEADERS["X-Frame-Options"], "DENY");
  assert.equal(DEFAULT_SECURITY_HEADERS["Referrer-Policy"], "no-referrer");
  const csp = DEFAULT_SECURITY_HEADERS["Content-Security-Policy"]!;
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  // An `unsafe-inline` / wildcard would defeat the point of shipping a CSP at all.
  assert.ok(!csp.includes("unsafe-inline"), "CSP must not allow inline scripts");
  assert.ok(!csp.includes("*"), "CSP must not use a wildcard source");
});

test("headersTimeout 必须 <= keepAliveTimeout，否则 Node 直接销毁连接", () => {
  assert.ok(
    DEFAULT_TIMEOUTS.headersTimeoutMs <= DEFAULT_TIMEOUTS.keepAliveTimeoutMs,
    "Node destroys connections when headersTimeout exceeds keepAliveTimeout",
  );
  // Long LLM turns need a generous request timeout.
  assert.ok(DEFAULT_TIMEOUTS.requestTimeoutMs >= 60_000);
});

/* ─────────────────── 指标：健壮性 ─────────────────── */

test("Metrics 对未知指标名静默忽略，不抛错（拼错的指标名不能带崩请求）", () => {
  const m = new Metrics();
  assert.doesNotThrow(() => m.inc("no_such_metric" as never));
  assert.doesNotThrow(() => m.addGauge("no_such_metric" as never, 1));
  assert.doesNotThrow(() => m.setGauge("no_such_metric" as never, 2));
  assert.equal(m.get("no_such_metric" as never), 0);
});

/* ─────────────────── 子进程环境裁剪 ─────────────────── */

/**
 * 回归：`PI_API_KEY` 被所有子进程继承。
 *
 * `loadEnvFile()` 把整个 .env 灌进 process.env，子进程若直接继承，那么开了 coding 档后
 * 任何 bash / exec 命令、任何 MCP 子进程都能 `echo $PI_API_KEY` 把模型密钥读走。
 */
test("子进程环境剔除项目密钥，其余变量原样保留", () => {
  assert.equal(isSecretEnvName("PI_API_KEY"), true);
  assert.equal(isSecretEnvName("PI_API_KEY_ZHIPU"), true);
  assert.equal(isSecretEnvName("pi_api_key_glm"), true, "大小写不敏感");
  assert.equal(isSecretEnvName("PI_MODEL"), false);
  assert.equal(isSecretEnvName("PATH"), false);

  const env = childProcessEnv({
    PATH: "/usr/bin",
    HOME: "/home/x",
    PI_API_KEY: "sk-secret",
    PI_API_KEY_ZHIPU: "sk-secret-2",
    PI_MODEL: "modelscope/x",
  });
  assert.equal(env.PI_API_KEY, undefined, "模型密钥绝不能进子进程环境");
  assert.equal(env.PI_API_KEY_ZHIPU, undefined);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/x");
  assert.equal(env.PI_MODEL, "modelscope/x", "非密钥的 PI_ 变量照常传递");
});

/* ─────────────────── 协议入口校验 ─────────────────── */

test("isClientMessage 只放行形态合法的命令名（拒绝数组与空/空白）", () => {
  assert.equal(isClientMessage({ type: "prompt" }), true);
  assert.equal(isClientMessage({ type: "biz_sum" }), true, "业务方自定义命令名必须放行");
  assert.equal(isClientMessage([{ type: "prompt" }]), false, "数组不是消息");
  assert.equal(isClientMessage({ type: "" }), false);
  assert.equal(isClientMessage({ type: "   " }), false);
  assert.equal(isClientMessage({ type: 3 }), false);
  assert.equal(isClientMessage(null), false);
});

/* ─────────────────── 客户端错误文案 ─────────────────── */

/**
 * 回归：WS 侧有 6 处直接 `err.message` 回给客户端，与 REST 的 `clientMessage()` 分叉。
 * 未知异常（SDK / 驱动抛出）常带绝对路径、连接串、库版本，属内部信息。
 */
test("clientErrorMessage：未标记暴露的 AppError 与未知异常都不原样外泄", () => {
  const internal = new AppError("internal", "ENOENT /home/u/.pi/agent/auth.json");
  assert.equal(clientErrorMessage(internal), internal.clientMessage());
  assert.ok(!clientErrorMessage(internal).includes("auth.json"), "内部 AppError 不得外泄原文");
  assert.ok(!clientErrorMessage(new Error("connect ECONNREFUSED 10.0.0.5:8080")).includes("10.0.0.5"));
  // 显式暴露的仍然是原文（4xx 类错误要能指导调用方）。
  assert.equal(clientErrorMessage(badRequest("model is required")), "model is required");
  // 自定义兜底文案只在「非 AppError」时生效。
  assert.equal(clientErrorMessage(new Error("boom"), "切换模型失败"), "切换模型失败");
  assert.equal(clientErrorMessage(badRequest("bad"), "fallback"), "bad");
});

/* ─────────────────── 敏感文件名策略（多方共用） ─────────────────── */

test("isDeniedName：精确 / 前缀 / 后缀 / 两端通配与大小写", () => {
  assert.equal(isDeniedName(".env"), true);
  assert.equal(isDeniedName(".env.local"), true, "`.env.*` 前缀通配");
  assert.equal(isDeniedName("MY.PEM"), true, "`*.pem` 后缀通配且大小写不敏感");
  assert.equal(isDeniedName("id_rsa"), true);
  assert.equal(isDeniedName("credentials.json"), true);
  assert.equal(isDeniedName("notes.txt"), false);
  assert.equal(isDeniedName("env"), false, "不能把 env 这种普通名误伤");
  // 名单本身就是契约：删条目等于重新打开一条旁路。
  for (const pattern of [".env", ".env.*", "auth.json", "*.pem", "id_rsa"]) {
    assert.ok(DEFAULT_DENY_NAMES.includes(pattern), `默认名单必须包含 ${pattern}`);
  }
});
