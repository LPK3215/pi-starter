/**
 * 类型化错误的回归测试。
 *
 * 核心主张只有一条：**未显式声明的错误不泄漏内部细节**。
 * 这类缺陷不会让测试变红，只会让生产环境的错误信息把数据库路径、
 * SQL 驱动报错、SDK 内部结构发给客户端——所以必须用断言钉死。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AppError,
  APP_ERROR_CODES,
  badRequest,
  busy,
  notFound,
  toAppError,
  validationFailed,
} from "./errors.js";

test("默认不暴露内部文案，只回通用提示", () => {
  const err = new AppError("internal", "connect ECONNREFUSED 127.0.0.1:5432 (pg-pool)");
  assert.equal(err.safeToExpose, false);
  assert.equal(err.clientMessage(), "服务器内部错误");
  assert.ok(!err.clientMessage().includes("5432"), "must not leak host/port");
  // …但服务端日志仍保留完整原因，否则等于把排障信息也丢了。
  assert.match(err.toLogFields().message as string, /5432/);
});

test("显式 expose 才回传原文", () => {
  assert.equal(badRequest("sql is required").clientMessage(), "sql is required");
  assert.equal(notFound("no such skill: x").clientMessage(), "no such skill: x");
  assert.equal(busy().clientMessage(), "agent is busy, try again shortly");
});

test("状态码按错误码取默认值，并可覆盖", () => {
  assert.equal(new AppError("not_found", "x").httpStatus, 404);
  assert.equal(new AppError("rate_limited", "x").httpStatus, 429);
  assert.equal(new AppError("payload_too_large", "x").httpStatus, 413);
  assert.equal(new AppError("internal", "x").httpStatus, 500);
  assert.equal(new AppError("bad_request", "x", { httpStatus: 418 }).httpStatus, 418);
});

test("各状态码都有对应的通用文案，不回落到 undefined", () => {
  for (const code of APP_ERROR_CODES) {
    const err = new AppError(code, "message");
    const msg = err.clientMessage();
    assert.ok(msg && msg.length > 0, `${code} must have a message`);
  }
});

test("internal 默认隐藏原文；面向调用方的错误码默认回传原文", () => {
  // The two halves of the contract. Suppressing caller-facing messages would only make
  // clients (and models) guess; exposing internal ones leaks paths and driver errors.
  assert.equal(new AppError("internal", "pg-pool ECONNREFUSED 127.0.0.1:5432").clientMessage(), "服务器内部错误");

  // Written for the caller → returned verbatim without needing `expose: true`.
  assert.equal(
    new AppError("read_only_sql", "检测到非只读关键字：DELETE").clientMessage(),
    "检测到非只读关键字：DELETE",
  );
  assert.equal(new AppError("validation_failed", "id must be an integer").clientMessage(), "id must be an integer");
  assert.equal(new AppError("not_found", "no such skill: x").clientMessage(), "no such skill: x");
});

test("显式 expose:false 可对任何错误强制隐藏（含面向调用方的码）", () => {
  const err = new AppError("bad_request", "internal detail", { expose: false });
  assert.equal(err.safeToExpose, false);
  assert.equal(err.clientMessage(), "请求无效");
});

test("toAppError 保留 AppError 身份，未知异常一律视为内部错误", () => {
  const original = new AppError("read_only_sql", "检测到非只读关键字：DELETE");
  assert.equal(toAppError(original), original, "must pass AppError through untouched");

  const wrapped = toAppError(new Error("ENOENT: /very/secret/path.json"));
  assert.equal(wrapped.httpStatus, 500);
  assert.ok(!wrapped.clientMessage().includes("secret"), "must not leak filesystem paths");
  assert.match(wrapped.toLogFields().message as string, /secret/, "log keeps the detail");
});

test("cause 链在日志字段里保留", () => {
  const root = new Error("root cause");
  const err = new AppError("internal", "wrapper", { cause: root });
  const fields = err.toLogFields();
  assert.deepEqual(fields.cause, { name: "Error", message: "root cause" });
});

test("details 只进日志，不进客户端文案", () => {
  const err = new AppError("internal", "boom", { details: { dbPath: "/var/data/app.db" } });
  assert.ok(!err.clientMessage().includes("/var/data"));
  assert.deepEqual(err.details, { dbPath: "/var/data/app.db" });
});

test("AppError 是真正的 Error 子类，可被 instanceof 与栈追踪识别", () => {
  const err = validationFailed("bad field");
  assert.ok(err instanceof AppError);
  assert.ok(err instanceof Error);
  assert.equal(err.name, "AppError");
  assert.ok(typeof err.stack === "string" && err.stack.length > 0);
});
