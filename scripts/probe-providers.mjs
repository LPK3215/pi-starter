/**
 * 探测 .env 里配置的两个 OpenAI 兼容平台：连通性 + 实际可用模型列表。
 *
 * 为什么需要：模型名不能靠猜（参考示例里的 id 未必在账号可用范围内）。
 * 脚手架的 `PI_MODELS` 目录要填**真实存在**的 model id，否则启动即失败。
 *
 * 密钥只从 .env 读，不打印、不落盘到别处。
 */
import { readFileSync } from "node:fs";

function loadEnv(file) {
  const out = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const env = loadEnv(process.argv[2] ?? ".env");
const targets = [
  { name: "modelscope", baseUrl: env.MODELSCOPE_BASE_URL, key: env.MODELSCOPE_API_KEY },
  { name: "sensenova", baseUrl: env.SENSENOVA_BASE_URL, key: env.SENSENOVA_API_KEY },
];

for (const t of targets) {
  console.log(`\n════ ${t.name} ════`);
  if (!t.baseUrl || !t.key) {
    console.log("  配置缺失（baseUrl / apiKey）");
    continue;
  }
  console.log(`  base_url = ${t.baseUrl}`);

  // 1) 模型列表
  let models = [];
  try {
    const res = await fetch(`${t.baseUrl}/models`, {
      headers: { authorization: `Bearer ${t.key}` },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (res.ok) {
      const body = JSON.parse(text);
      models = (body.data ?? []).map((m) => m.id).filter(Boolean);
      console.log(`  GET /models → ${res.status}，共 ${models.length} 个`);
      for (const id of models.slice(0, 40)) console.log(`    · ${id}`);
      if (models.length > 40) console.log(`    …… 另有 ${models.length - 40} 个`);
    } else {
      console.log(`  GET /models → ${res.status} ${text.slice(0, 160)}`);
    }
  } catch (err) {
    console.log(`  GET /models 失败：${err.message}`);
  }

  // 2) 真实流式对话——这是脚手架实际走的那条路
  const candidates = models.length ? models.slice(0, 5) : [];
  for (const model of candidates) {
    try {
      const res = await fetch(`${t.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${t.key}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "回复两个字：就绪" }],
          stream: true,
          max_tokens: 32,
        }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) {
        const text = await res.text();
        console.log(`  ✖ ${model} → ${res.status} ${text.slice(0, 140)}`);
        continue;
      }
      let chars = 0;
      let pieces = 0;
      for await (const chunk of res.body) {
        pieces += 1;
        chars += chunk.byteLength;
      }
      console.log(`  ✔ ${model} → 流式正常，${pieces} 个数据块 / ${chars} 字节`);
    } catch (err) {
      console.log(`  ✖ ${model} → ${err.message}`);
    }
  }
}
