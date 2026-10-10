/**
 * 发给 SDK `prompt` / `steer` / `followUp` 的图片。
 *
 * SDK 的 `ImageContent` 是 `{ type: "image", data, mimeType }`，data 为不带前缀的 base64。
 * 这里只做形状和大小校验，不解码成像素，也不另存文件。
 */

import type { ImageContent } from "@earendil-works/pi-ai";
import { badRequest } from "./errors.js";

export const MAX_PROMPT_IMAGES = 4;
export const MAX_IMAGE_BYTES = 512 * 1024;

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function parsePromptImages(raw: unknown): ImageContent[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) throw badRequest("images 必须是数组");
  if (raw.length === 0) return undefined;
  if (raw.length > MAX_PROMPT_IMAGES) {
    throw badRequest(`一次最多 ${MAX_PROMPT_IMAGES} 张图片`);
  }
  return raw.map((item, index) => toImage(item, index));
}

function toImage(item: unknown, index: number): ImageContent {
  const label = `第 ${index + 1} 张图片`;
  if (!item || typeof item !== "object") throw badRequest(`${label}无效`);
  const mimeType = (item as { mimeType?: unknown }).mimeType;
  const data = (item as { data?: unknown }).data;
  if (typeof mimeType !== "string" || !IMAGE_MIME.has(mimeType)) {
    throw badRequest(`${label}的类型不支持`);
  }
  if (typeof data !== "string" || data.length === 0 || data.startsWith("data:")) {
    throw badRequest(`${label}必须是 base64，不要带 data: 前缀`);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw badRequest(`${label}不是合法的 base64`);
  }
  const decoded = Buffer.from(data, "base64");
  if (decoded.length === 0 || decoded.length > MAX_IMAGE_BYTES) {
    throw badRequest(`${label}为空或超过 ${MAX_IMAGE_BYTES} 字节`);
  }
  return { type: "image", data, mimeType };
}
