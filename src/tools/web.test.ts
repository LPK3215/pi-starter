/**
 * 联网工具的行为测试。
 *
 * 全部离线：SSRF 判定、HTML→文本、参数夹取都是纯函数；工具层用假 WebClient，
 * **绝不发真实请求**（`verify` 链条不能依赖外网，否则网络抖动就是假红）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveWebConfig } from "../config.js";
import { allTools } from "./index.js";
import {
  DEFAULT_FETCH_MAX_BYTES,
  MAX_FETCH_MAX_BYTES,
  MAX_SEARCH_LIMIT,
  WebError,
  assertPublicUrl,
  clampWebNumber,
  createWebFetchTool,
  createWebSearchTool,
  htmlToText,
  isPrivateAddress,
  webRegistrySpecs,
  webToolsForMode,
  type SearchHit,
  type WebClient,
} from "./web.js";
import { inferRisk } from "./registry.js";

/**
 * 假后端：不发请求，记录被调用的参数。
 *
 * 泛型是为了让 `fakeClient({ search })` 的返回类型**保留** `search` 必填这一事实，
 * 从而能直接喂给要求可搜索后端的 `createWebSearchTool`。
 */
function fakeClient<T extends Partial<WebClient> = Record<never, never>>(
  overrides: T = {} as T,
): WebClient & T & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    kind: "fake",
    calls,
    async fetchPage(url, options) {
      calls.push({ url, options });
      return {
        url,
        status: 200,
        contentType: "text/html",
        text: `正文 ${url}`,
        truncated: false,
      };
    },
    ...overrides,
  };
}

/** 调工具并抽出返回的文本。 */
async function runTool(tool: { execute: (...args: never[]) => Promise<unknown> }, params: unknown): Promise<string> {
  const result = (await (tool.execute as unknown as (
    id: string,
    params: unknown,
    signal: undefined,
    update: undefined,
    ctx: never,
  ) => Promise<{ content: Array<{ type: string; text?: string }> }>)("call-1", params, undefined, undefined, undefined as never));
  return result.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
}

/* ────────────────────────── SSRF 防护 ────────────────────────── */

test("私有 / 保留地址判定：本机、内网、链路本地、组播、IPv4 映射都算私有", () => {
  for (const ip of [
    "127.0.0.1",
    "0.0.0.0",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // 云元数据
    "100.64.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} 应判为私有`);
  }
  for (const ip of ["8.8.8.8", "93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isPrivateAddress(ip), false, `${ip} 应判为公网`);
  }
  // 认不出来的一律 fail-closed
  assert.equal(isPrivateAddress("not-an-ip"), true);
});

test("assertPublicUrl：只放行 http/https 的公网地址", async () => {
  await assert.rejects(() => assertPublicUrl("file:///etc/passwd"), (err: unknown) => {
    assert.ok(err instanceof WebError);
    assert.equal(err.code, "bad_url");
    return true;
  });
  await assert.rejects(() => assertPublicUrl("ftp://example.com/x"), /只支持 http\/https/);
  await assert.rejects(() => assertPublicUrl("这不是 URL"), /不是合法的 URL/);

  for (const url of [
    "http://localhost/",
    "http://foo.localhost/",
    "http://metadata.google.internal/",
    "http://127.0.0.1:3000/health",
    "http://10.0.0.1/",
    "http://192.168.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]:3000/",
    "http://[::ffff:127.0.0.1]/",
  ]) {
    await assert.rejects(
      () => assertPublicUrl(url),
      (err: unknown) => {
        assert.ok(err instanceof WebError, `${url} 应抛 WebError`);
        assert.equal(err.code, "blocked_host", `${url} 应判为 blocked_host`);
        return true;
      },
      `${url} 必须被拒绝`,
    );
  }

  // 公网 IP 字面量：不需要 DNS，直接放行。
  const ok = await assertPublicUrl("https://93.184.216.34/docs?v=1");
  assert.equal(ok.hostname, "93.184.216.34");
});

/* ────────────────────────── HTML → 文本 ────────────────────────── */

test("htmlToText：剥掉 script/style/标签，解码常见实体，压掉多余空行", () => {
  const html = [
    "<!doctype html><html><head><style>body{color:red}</style>",
    "<script>var x = '<b>not text</b>';</script></head>",
    "<body><h1>标题</h1><p>第一段 &amp; 第二段</p>",
    "<div>换行<br>了</div><ul><li>a</li><li>b</li></ul>",
    "<!-- 注释不该出现 --><p>&lt;code&gt; &quot;引号&quot; &#39;撇号&#39; &nbsp;尾巴</p>",
    "</body></html>",
  ].join("");
  const text = htmlToText(html);
  assert.ok(!text.includes("not text"), "script 内容必须被剥掉");
  assert.ok(!text.includes("color:red"), "style 内容必须被剥掉");
  assert.ok(!text.includes("注释不该出现"), "注释必须被剥掉");
  assert.ok(text.includes("标题"));
  assert.ok(text.includes("第一段 & 第二段"), "实体要解码");
  assert.ok(text.includes("<code> \"引号\" '撇号'"), "尖引号实体要解码");
  assert.ok(text.includes("\n"), "块级标签要产生换行");
  assert.ok(!/\n{3,}/.test(text), "不该出现三连空行");
});

/* ────────────────────────── 工具层 ────────────────────────── */

test("web_fetch：成功时返回最终 URL 与正文，失败时如实说明而不是抛错", async () => {
  const client = fakeClient();
  const tool = createWebFetchTool(client);

  const ok = await runTool(tool, { url: "https://example.com/a" });
  assert.match(ok, /URL: https:\/\/example\.com\/a/);
  assert.match(ok, /HTTP: 200/);
  assert.match(ok, /正文 https:\/\/example\.com\/a/);

  const failing = createWebFetchTool(
    fakeClient({
      async fetchPage() {
        throw new WebError("拒绝访问内网地址：127.0.0.1", "blocked_host");
      },
    }),
  );
  const text = await runTool(failing, { url: "http://127.0.0.1/" });
  assert.match(text, /抓取失败：拒绝访问内网地址/);
  assert.ok(!text.includes("正文"), "失败时绝不能编造正文");
});

test("web_fetch：maxBytes 原样透传给后端（夹取在后端做，见下一例）", async () => {
  const client = fakeClient();
  const tool = createWebFetchTool(client);

  await runTool(tool, { url: "https://example.com/a", maxBytes: 4096 });
  assert.equal((client.calls[0]?.options as { maxBytes?: number }).maxBytes, 4096);

  await runTool(tool, { url: "https://example.com/b" });
  assert.equal(client.calls[1]?.url, "https://example.com/b");
});

test("clampWebNumber：模型传入的字节上限被夹进上界，非数值回落默认值", () => {
  assert.equal(clampWebNumber(999_999_999, DEFAULT_FETCH_MAX_BYTES, 1, MAX_FETCH_MAX_BYTES), MAX_FETCH_MAX_BYTES);
  assert.equal(clampWebNumber(-1, DEFAULT_FETCH_MAX_BYTES, 1, MAX_FETCH_MAX_BYTES), 1);
  assert.equal(clampWebNumber(Number.NaN, DEFAULT_FETCH_MAX_BYTES, 1, MAX_FETCH_MAX_BYTES), DEFAULT_FETCH_MAX_BYTES);
  assert.equal(clampWebNumber(undefined, DEFAULT_FETCH_MAX_BYTES, 1, MAX_FETCH_MAX_BYTES), DEFAULT_FETCH_MAX_BYTES);
  assert.equal(clampWebNumber(4096.7, DEFAULT_FETCH_MAX_BYTES, 1, MAX_FETCH_MAX_BYTES), 4096);
});

test("web_search：有结果时逐条列出，没结果时如实说没有", async () => {
  const hits: SearchHit[] = [
    { title: "结果一", url: "https://a.example", snippet: "摘要一" },
    { title: "结果二", url: "https://b.example", snippet: "摘要二" },
  ];
  const tool = createWebSearchTool(fakeClient({ search: async () => hits }));
  const text = await runTool(tool, { query: "pi agent" });
  assert.match(text, /1\. 结果一/);
  assert.match(text, /https:\/\/b\.example/);

  const empty = createWebSearchTool(fakeClient({ search: async () => [] }));
  assert.match(await runTool(empty, { query: "xyz" }), /没有搜到/);
});

test("web_search：limit 入参被夹到 [1, MAX_SEARCH_LIMIT]", async () => {
  const seen: number[] = [];
  const tool = createWebSearchTool(
    fakeClient({
      async search(_query, limit) {
        seen.push(limit);
        return [];
      },
    }),
  );
  await runTool(tool, { query: "a", limit: 10_000 });
  await runTool(tool, { query: "a", limit: -5 });
  await runTool(tool, { query: "a", limit: Number.NaN });
  assert.deepEqual(seen, [MAX_SEARCH_LIMIT, 1, 5]);
});

/* ────────────────────────── 装配 ────────────────────────── */

test("webToolsForMode：默认关；开了但后端没有 search 时**不注册** web_search", () => {
  assert.deepEqual(webToolsForMode(false), []);
  assert.deepEqual(
    webToolsForMode(true, fakeClient()).map((tool) => tool.name),
    ["web_fetch"],
  );
  assert.deepEqual(
    webToolsForMode(true, fakeClient({ search: async () => [] })).map((tool) => tool.name),
    ["web_fetch", "web_search"],
  );
});

test("联网工具的能力标签是 net，风险因此是 medium（可被审批与 UI 识别）", () => {
  const specs = webRegistrySpecs(["web_fetch", "web_search"]);
  assert.deepEqual(specs.map((spec) => spec.name), ["web_fetch", "web_search"]);
  for (const spec of specs) {
    assert.ok(spec.capabilities.includes("net"), `${spec.name} 应带 net 能力标签`);
    assert.equal(inferRisk(spec.capabilities), "medium");
    assert.equal(spec.source, "custom");
  }
  assert.deepEqual(webRegistrySpecs(["web_fetch"]).map((spec) => spec.name), ["web_fetch"]);
  assert.deepEqual(webRegistrySpecs([]), []);
});

test("联网工具接在组装层与 Web 注册表上，且默认不在 allTools 里", () => {
  assert.equal(
    allTools.some((tool) => tool.name === "web_fetch" || tool.name === "web_search"),
    false,
    "联网工具不能进 allTools，否则 off 档也会放行一个能把上下文发出去的工具",
  );
  const agentSrc = readFileSync(fileURLToPath(new URL("../agent.ts", import.meta.url)), "utf8");
  const serverSrc = readFileSync(fileURLToPath(new URL("../server.ts", import.meta.url)), "utf8");
  assert.match(agentSrc, /webToolsForMode\(webEnabled, options\.webClient\)/);
  assert.match(agentSrc, /web: \{ enabled: webTools\.length > 0/);
  assert.match(serverSrc, /webRegistrySpecs\(agent\.web\.toolNames\)/);
});

test("PI_WEB 只有明确的 on/true/1 才算开——拼错不等于偷偷打开", () => {
  assert.deepEqual(resolveWebConfig({}), { enabled: false });
  assert.deepEqual(resolveWebConfig({ PI_WEB: "off" }), { enabled: false });
  assert.deepEqual(resolveWebConfig({ PI_WEB: "yes" }), { enabled: false });
  assert.deepEqual(resolveWebConfig({ PI_WEB: "ON" }), { enabled: true });
  assert.deepEqual(resolveWebConfig({ PI_WEB: "true" }), { enabled: true });
  assert.deepEqual(resolveWebConfig({ PI_WEB: "1", PI_WEB_MAX_BYTES: "4096" }), {
    enabled: true,
    maxBytes: 4096,
  });
  // 非数值 / 非正数不生效（回落内置默认），不抛错。
  assert.deepEqual(resolveWebConfig({ PI_WEB: "on", PI_WEB_MAX_BYTES: "abc" }), { enabled: true });
});

/* ────────────────────── HttpWebClient 的真实抓取路径 ────────────────────── */
// 之前只测了假后端：`fetchPage` 里字节上限、重定向、超时、content-type 判定
// 全都没被真实执行过。这里起本地 HTTP 服务来跑，并注入 host 策略
// （否则回环地址会被自己的 SSRF 防护挡住，压根连不上测试服务）。

import { createServer, type Server } from "node:http";
import { HttpWebClient, MAX_REDIRECTS } from "./web.js";

interface LocalServer {
  base: string;
  port: number;
  hits: string[];
  close: () => Promise<void>;
}

/** 起一个本地服务；`route(req) => { status, headers, body, delayMs, redirectTo }`。 */
async function serve(
  route: (req: { url: string; headers: Record<string, string | string[] | undefined> }) =>
    | { status?: number; headers?: Record<string, string>; body?: string; delayMs?: number; redirectTo?: string }
    | undefined,
): Promise<LocalServer> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(req.url ?? "/");
    const plan = route({ url: req.url ?? "/", headers: req.headers }) ?? {};
    const respond = () => {
      const headers: Record<string, string> = { ...(plan.headers ?? {}) };
      if (plan.redirectTo) {
        res.writeHead(plan.status ?? 302, { ...headers, location: plan.redirectTo });
        res.end();
        return;
      }
      const body = plan.body ?? "";
      res.writeHead(plan.status ?? 200, {
        "content-type": "text/plain; charset=utf-8",
        ...headers,
        "content-length": String(Buffer.byteLength(body)),
      });
      res.end(body);
    };
    if (plan.delayMs) setTimeout(respond, plan.delayMs);
    else respond();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 只挡指定端口，其余放行 —— 用它来模拟「公网站点把请求 302 到内网」。 */
const guardBlocking = (blockedPort: number) => async (url: URL) => {
  if (url.port === String(blockedPort)) {
    throw new WebError(`拒绝访问内网地址：${url.hostname}:${url.port}`, "blocked_host");
  }
};

test("fetchPage：200 文本原样返回；HTML 被转成纯文本", async () => {
  const s = await serve((req) =>
    req.url === "/page"
      ? { headers: { "content-type": "text/html; charset=utf-8" }, body: "<h1>标题</h1><script>var x=1</script><p>正文</p>" }
      : { headers: { "content-type": "application/json" }, body: '{"a":1}' },
  );
  const client = new HttpWebClient({ urlGuard: async () => {} });
  try {
    const page = await client.fetchPage(`${s.base}/page`);
    assert.equal(page.status, 200);
    assert.match(page.contentType, /text\/html/);
    assert.ok(page.text.includes("标题") && page.text.includes("正文"));
    assert.ok(!page.text.includes("var x=1"), "HTML 路径要剥掉 script");
    assert.equal(page.truncated, false);

    const json = await client.fetchPage(`${s.base}/data`);
    assert.equal(json.text, '{"a":1}', "JSON 不该被当 HTML 拍平");
  } finally {
    await s.close();
  }
});

test("fetchPage：正文**恰好等于**上限时报 truncated=false（差一错误的回归）", async () => {
  const exact = "x".repeat(64);
  const s = await serve(() => ({ headers: { "content-type": "text/plain" }, body: exact }));
  const client = new HttpWebClient({ urlGuard: async () => {} });
  try {
    const page = await client.fetchPage(`${s.base}/`, { maxBytes: 64 });
    assert.equal(page.text.length, 64);
    assert.equal(page.truncated, false, "恰好等于上限时一个字都没丢，不能报截断");
  } finally {
    await s.close();
  }
});

test("fetchPage：超过上限时截断并标记，且不把整页读进内存", async () => {
  const s = await serve(() => ({ headers: { "content-type": "text/plain" }, body: "y".repeat(4096) }));
  const client = new HttpWebClient({ urlGuard: async () => {} });
  try {
    const page = await client.fetchPage(`${s.base}/`, { maxBytes: 100 });
    assert.equal(page.truncated, true);
    assert.equal(page.text.length, 100);
  } finally {
    await s.close();
  }
});

test("fetchPage：非 2xx 与二进制 content-type 都翻成可读的 WebError", async () => {
  const s = await serve((req) =>
    req.url === "/missing"
      ? { status: 404, body: "nope" }
      : { headers: { "content-type": "image/png" }, body: "\u0000\u0001" },
  );
  const client = new HttpWebClient({ urlGuard: async () => {} });
  try {
    await assert.rejects(
      () => client.fetchPage(`${s.base}/missing`),
      (err: unknown) => {
        assert.ok(err instanceof WebError);
        assert.equal(err.code, "http_error");
        assert.match(err.message, /HTTP 404/);
        return true;
      },
    );
    await assert.rejects(
      () => client.fetchPage(`${s.base}/blob`),
      (err: unknown) => {
        assert.ok(err instanceof WebError);
        assert.equal(err.code, "not_text");
        assert.match(err.message, /image\/png/);
        return true;
      },
    );
  } finally {
    await s.close();
  }
});

test("fetchPage：正常跟随重定向，且**每一跳都过 host 策略**", async () => {
  const seen: string[] = [];
  const s = await serve((req) =>
    req.url === "/a" ? { redirectTo: "/b" } : req.url === "/b" ? { redirectTo: "/c" } : { body: "done" },
  );
  const client = new HttpWebClient({
    urlGuard: async (url) => {
      seen.push(url.pathname);
    },
  });
  try {
    const page = await client.fetchPage(`${s.base}/a`);
    assert.equal(page.text, "done");
    assert.equal(page.url, `${s.base}/c`, "返回的应是最终地址");
    assert.deepEqual(seen, ["/a", "/b", "/c"], "三跳都要在请求之前被校验");
    assert.deepEqual(s.hits, ["/a", "/b", "/c"]);
  } finally {
    await s.close();
  }
});

test("fetchPage：302 到被禁主机时**请求根本不会发出**（逐跳校验的回归）", async () => {
  const internal = await serve(() => ({ body: "内部数据" }));
  const publicish = await serve(() => ({ redirectTo: `${internal.base}/secret` }));
  const client = new HttpWebClient({ urlGuard: guardBlocking(internal.port) });
  try {
    await assert.rejects(
      () => client.fetchPage(`${publicish.base}/a`),
      (err: unknown) => {
        assert.ok(err instanceof WebError);
        assert.equal(err.code, "blocked_host");
        return true;
      },
    );
    // 这条断言才是重点：原实现用 redirect:"follow"，请求会**先打到内网**再校验。
    assert.deepEqual(internal.hits, [], "被禁主机一个请求都不能收到");
  } finally {
    await publicish.close();
    await internal.close();
  }
});

test("fetchPage：重定向次数超过上限即停，不会无限跟", async () => {
  const s = await serve(() => ({ redirectTo: "/loop" }));
  const client = new HttpWebClient({ urlGuard: async () => {} });
  try {
    await assert.rejects(
      () => client.fetchPage(`${s.base}/loop`),
      (err: unknown) => {
        assert.ok(err instanceof WebError);
        assert.equal(err.code, "network");
        assert.match(err.message, new RegExp(`重定向次数超过 ${MAX_REDIRECTS} 次`));
        return true;
      },
    );
    assert.equal(s.hits.length, MAX_REDIRECTS + 1, `最多请求 ${MAX_REDIRECTS + 1} 次（初始 1 次 + 跟 ${MAX_REDIRECTS} 跳）`);
  } finally {
    await s.close();
  }
});

test("fetchPage：超时翻成 timeout（而不是笼统的网络错误）", async () => {
  const s = await serve(() => ({ body: "慢了", delayMs: 300 }));
  const client = new HttpWebClient({ urlGuard: async () => {} });
  try {
    await assert.rejects(
      () => client.fetchPage(`${s.base}/slow`, { timeoutMs: 30 }),
      (err: unknown) => {
        assert.ok(err instanceof WebError);
        assert.equal(err.code, "timeout");
        assert.match(err.message, /抓取超时（30ms）/);
        return true;
      },
    );
  } finally {
    await s.close();
  }
});

test("fetchPage：即使注入了放行的 host 策略，非 http/https 仍然被拒", async () => {
  const client = new HttpWebClient({ urlGuard: async () => {} });
  await assert.rejects(
    () => client.fetchPage("file:///etc/passwd"),
    (err: unknown) => {
      assert.ok(err instanceof WebError);
      assert.equal(err.code, "bad_url");
      return true;
    },
  );
  await assert.rejects(() => client.fetchPage("ws://example.com/"), /只支持 http\/https/);
});

test("fetchPage：重定向目标不是合法 URL 时报错，而不是崩在 new URL 里", async () => {
  const s = await serve(() => ({ redirectTo: "http://[not a url" }));
  const client = new HttpWebClient({ urlGuard: async () => {} });
  try {
    await assert.rejects(
      () => client.fetchPage(`${s.base}/a`),
      (err: unknown) => {
        assert.ok(err instanceof WebError);
        assert.equal(err.code, "bad_url");
        return true;
      },
    );
  } finally {
    await s.close();
  }
});

test("限额常量有明确的上界（模型不能靠参数把上限顶掉）", () => {
  assert.ok(DEFAULT_FETCH_MAX_BYTES > 0 && DEFAULT_FETCH_MAX_BYTES <= MAX_FETCH_MAX_BYTES);
  assert.ok(MAX_SEARCH_LIMIT >= 1);
});
