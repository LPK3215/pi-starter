/**
 * 出图入参校验（`parsePromptImages`）测试。
 *
 * 这个函数是 `prompt` / `steer` / `follow_up` 三条 WS 命令共用的**唯一入口校验**，
 * 而它此前只被间接带到（覆盖率 44%）——意味着「模型收到一张损坏的图」这条路径
 * 从来没被验证过。它的职责是 fail-closed：宁可 400，也不要把半个 base64 传给模型。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "./errors.js";
import { MAX_IMAGE_BYTES, MAX_PROMPT_IMAGES, parsePromptImages } from "./prompt-images.js";

/** 断言抛出的是 400 类的 AppError，并且文案里带上是第几张图。 */
function expectBadRequest(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof AppError, `应抛 AppError，实际 ${String(err)}`);
    assert.equal(err.code, "bad_request");
    assert.equal(err.httpStatus, 400);
    assert.match(err.message, pattern);
    return true;
  });
}

const png = (bytes = 8) => Buffer.alloc(bytes, 7).toString("base64");

test("没有 images / 空数组都返回 undefined（而不是空数组）", () => {
  assert.equal(parsePromptImages(undefined), undefined);
  assert.equal(parsePromptImages(null), undefined);
  assert.equal(parsePromptImages([]), undefined);
});

test("非数组、超过张数上限都被拒", () => {
  expectBadRequest(() => parsePromptImages("not an array"), /images 必须是数组/);
  expectBadRequest(() => parsePromptImages({ data: "x" }), /images 必须是数组/);
  expectBadRequest(
    () => parsePromptImages(Array.from({ length: MAX_PROMPT_IMAGES + 1 }, () => ({ mimeType: "image/png", data: png() }))),
    /一次最多 4 张图片/,
  );
  // 恰好等于上限要放行（边界不能差一）
  const ok = parsePromptImages(Array.from({ length: MAX_PROMPT_IMAGES }, () => ({ mimeType: "image/png", data: png() })));
  assert.equal(ok?.length, MAX_PROMPT_IMAGES);
});

test("MIME 白名单：png / jpeg / gif / webp 放行，其余一律拒", () => {
  for (const mimeType of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
    const parsed = parsePromptImages([{ mimeType, data: png() }]);
    assert.equal(parsed?.[0]?.mimeType, mimeType, `${mimeType} 应放行`);
    assert.equal(parsed?.[0]?.type, "image");
    assert.equal(parsed?.[0]?.data, png(), "data 必须原样透传（不带前缀）");
  }
  // svg 不在白名单：它能内嵌脚本，不能当「图片」直接喂给模型。
  for (const mimeType of ["image/svg+xml", "image/bmp", "text/plain", "", undefined, 42]) {
    expectBadRequest(() => parsePromptImages([{ mimeType, data: png() }]), /第 1 张图片的类型不支持/);
  }
});

test("data 必须是裸 base64：带 data: 前缀、空串、非法字符都被拒", () => {
  expectBadRequest(
    () => parsePromptImages([{ mimeType: "image/png", data: "data:image/png;base64,iVBORw0KGgo=" }]),
    /不要带 data: 前缀/,
  );
  expectBadRequest(() => parsePromptImages([{ mimeType: "image/png", data: "" }]), /必须是 base64/);
  expectBadRequest(() => parsePromptImages([{ mimeType: "image/png", data: 123 }]), /必须是 base64/);
  expectBadRequest(() => parsePromptImages([{ mimeType: "image/png", data: "not base64!!" }]), /不是合法的 base64/);
  expectBadRequest(() => parsePromptImages([{ mimeType: "image/png", data: "a b c" }]), /不是合法的 base64/);
});

test("解码后为空或超过上限都被拒（正则过得了不代表是图）", () => {
  // "a" 符合 base64 字符集，但解码为 0 字节 —— 单字符垃圾必须被「为空」这一条拦住。
  expectBadRequest(() => parsePromptImages([{ mimeType: "image/png", data: "a" }]), /为空或超过/);

  const tooBig = Buffer.alloc(MAX_IMAGE_BYTES + 1, 1).toString("base64");
  expectBadRequest(() => parsePromptImages([{ mimeType: "image/png", data: tooBig }]), /为空或超过/);

  const exact = Buffer.alloc(MAX_IMAGE_BYTES, 1).toString("base64");
  assert.equal(parsePromptImages([{ mimeType: "image/png", data: exact }])?.length, 1, "恰好等于上限要放行");
});

test("元素不是对象时报错文案带序号，便于定位是哪一张", () => {
  expectBadRequest(() => parsePromptImages(["nope"]), /第 1 张图片无效/);
  expectBadRequest(
    () => parsePromptImages([{ mimeType: "image/png", data: png() }, null]),
    /第 2 张图片无效/,
  );
});
