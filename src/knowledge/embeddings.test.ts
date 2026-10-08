import assert from "node:assert/strict";
import { test } from "node:test";
import { OllamaEmbeddings, OpenAICompatEmbeddings } from "./embeddings.js";

// 假 fetch：记录请求、返回可控响应。避免联网。
type Captured = { url: string; init?: RequestInit };
function fakeFetch(captured: Captured[], payload: unknown, ok = true) {
  return (async (input: string, init?: RequestInit) => {
    captured.push({ url: input, init });
    return {
      ok,
      status: ok ? 200 : 500,
      async json() {
        return payload;
      },
      async text() {
        return JSON.stringify(payload);
      },
    } as unknown as Response;
  }) as (i: string, init?: RequestInit) => Promise<Response>;
}

test("OpenAICompatEmbeddings：打 /v1... /embeddings、带 auth、按 index 对齐 data", async () => {
  const cap: Captured[] = [];
  const provider = new OpenAICompatEmbeddings({
    baseUrl: "https://api.example/v1",
    apiKey: "sk-test",
    model: "embed-m",
    fetchImpl: fakeFetch(cap, {
      data: [
        { index: 1, embedding: [0.2, 0.3] },
        { index: 0, embedding: [0.1, 0.5] },
      ],
    }),
  });
  const out = await provider.embed(["a", "b"]);
  assert.equal(cap[0]?.url, "https://api.example/v1/embeddings");
  assert.match(String((cap[0]!.init!.headers as Record<string, string>).authorization), /Bearer sk-test/);
  const body = JSON.parse(String(cap[0]!.init!.body));
  assert.deepEqual(body, { model: "embed-m", input: ["a", "b"] });
  // 乱序的 data 按 index 重排，结果顺序 = 输入顺序
  assert.deepEqual(out, [[0.1, 0.5], [0.2, 0.3]]);
});

test("OpenAICompatEmbeddings：空输入不发请求；非 2xx 抛错", async () => {
  const cap: Captured[] = [];
  const provider = new OpenAICompatEmbeddings({ baseUrl: "https://x/v1", model: "m", fetchImpl: fakeFetch(cap, {}) });
  assert.deepEqual(await provider.embed([]), []);
  assert.equal(cap.length, 0);

  const failing = new OpenAICompatEmbeddings({ baseUrl: "https://x/v1", model: "m", fetchImpl: fakeFetch([], { error: "boom" }, false) });
  await assert.rejects(() => failing.embed(["a"]), /HTTP 500/);
});

test("OllamaEmbeddings：默认端口打 /api/embed、解析 embeddings", async () => {
  const cap: Captured[] = [];
  const provider = new OllamaEmbeddings({ model: "nomic-embed", fetchImpl: fakeFetch(cap, { embeddings: [[1, 2], [3, 4]] }) });
  const out = await provider.embed(["x", "y"]);
  assert.equal(cap[0]?.url, "http://127.0.0.1:11434/api/embed");
  assert.deepEqual(JSON.parse(String(cap[0]!.init!.body)), { model: "nomic-embed", input: ["x", "y"] });
  assert.deepEqual(out, [[1, 2], [3, 4]]);
});
