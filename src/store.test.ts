/**
 * 持久化测试。
 *
 * 关注两类真实故障——它们决定了「落盘」是可靠还是反而制造了死局：
 *   1. **写到一半被杀** → 文件截断 → 下次启动读不回来（原子写要防的正是这个）；
 *   2. **文件损坏 / 内容不合 schema** → 必须回落可用默认值，而不是让服务起不来。
 *      审批规则更严格：一条畸形规则绝不能被当成「无规则」从而放行高危命令。
 */
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, readdirSync } from "node:fs";

import { join } from "node:path";
import { test } from "node:test";
import {
  SettingsService,
  fileSettingsPort,
  defaultSettingsFile,
  memorySettingsPort,
  sanitizeSettings,
  MAX_MCP_SERVERS,
  SETTINGS_DEFAULTS,
} from "./settings.js";
import {
  ApprovalRulesStore,
  loadApprovalRulesFromFile,
  saveApprovalRulesToFile,
} from "./approval/rules.js";
import { tempDir } from "./test-tmp.js";

function tmpDir(): string {
  return tempDir("pi-store-");
}

test("持久化：设置落盘后重启不丢（新实例读回同一份）", () => {
  const file = join(tmpDir(), "settings.json");
  const first = new SettingsService(fileSettingsPort(file));
  first.patch({ toolApprovalEnabled: true, contextKeepRecent: 12, disabledTools: ["bash"] });

  // 关键：换一个实例（即模拟重启），读到的必须是落盘的值而非默认值。
  const second = new SettingsService(fileSettingsPort(file));
  assert.equal(second.get().toolApprovalEnabled, true);
  assert.equal(second.get().contextKeepRecent, 12);
  assert.deepEqual(second.get().disabledTools, ["bash"]);
});

test("持久化：文件不存在时走默认值，且不会报错", () => {
  const svc = new SettingsService(fileSettingsPort(join(tmpDir(), "nope.json")));
  assert.deepEqual(svc.get(), SETTINGS_DEFAULTS);
});

test("持久化：损坏的设置文件回落默认值而不是让服务起不来", () => {
  const file = join(tmpDir(), "broken.json");
  writeFileSync(file, "{ this is not json ");
  const warned: string[] = [];
  const svc = new SettingsService(fileSettingsPort(file, { logger: (msg) => warned.push(msg) }));
  assert.deepEqual(svc.get(), SETTINGS_DEFAULTS, "must fall back to defaults");
  assert.ok(warned.length > 0, "a corrupted config must be reported, not silently swallowed");

  // 回落之后仍可正常写入（用户改回来即可）。
  svc.patch({ locale: "en-US" });
  assert.equal(svc.get().locale, "en-US");
});

/**
 * 回归：能解析但内容不合法的配置文件，曾让整个服务起不来。
 *
 * `SettingsService.normalize` 对未知字段是`throw` 的——这对 `PATCH /settings` 是对的
 *（防止任意 JSON 注入），但配置文件是用户自己早先写下的东西：里面可能有旧版本遗留字段。
 * 让它把服务卡死是最差结果（用户只能手工删文件才能救）。
 */
test("持久化：字段非法/未知的配置文件只剔除该字段，服务照常起来", () => {
  const file = join(tmpDir(), "settings.json");
  writeFileSync(
    file,
    JSON.stringify({
      toolApprovalEnabled: true, // 合法，必须保留
      legacyRemovedField: "x", // 旧版本遗留字段
      contextKeepRecent: 9999, // 类型/范围不合法
      alsoUnknown: 123,
    }),
  );

  const dropped: string[] = [];
  // 不抛错即达标——这正是修复前会崩的地方。
  const svc = new SettingsService(
    fileSettingsPort(file, {
      sanitize: (raw) => {
        const result = sanitizeSettings(raw);
        dropped.push(...result.dropped);
        return result.clean;
      },
    }),
  );

  assert.equal(svc.get().toolApprovalEnabled, true, "valid fields must survive");
  assert.deepEqual(
    [...dropped].sort(),
    ["alsoUnknown", "contextKeepRecent", "legacyRemovedField"],
    "every invalid field must be reported, not silently dropped",
  );
  // 非法字段回落成默认值，而不是变成别的值。
  assert.equal(svc.get().contextKeepRecent, SETTINGS_DEFAULTS.contextKeepRecent);
});

test("持久化：sanitizeSettings 剔除非法字段但保留合法字段", () => {
  const { clean, dropped } = sanitizeSettings({
    locale: "en-US",
    toolTimeoutSeconds: 600,
    nope: 1,
    contextKeepRecent: -5,
    disabledTools: "not-an-array",
  });
  assert.equal(clean.locale, "en-US");
  assert.equal(clean.toolTimeoutSeconds, 600);
  assert.equal(clean.nope, undefined);
  assert.equal(clean.contextKeepRecent, undefined);
  assert.equal(clean.disabledTools, undefined);
  assert.deepEqual(dropped.sort(), ["contextKeepRecent", "disabledTools", "nope"]);
  assert.deepEqual(sanitizeSettings(undefined).clean, {});
});

test("持久化：mcpServers 逐条校验，错误信息带下标", () => {
  const svc = new SettingsService(memorySettingsPort());
  const good = { name: "demo", command: "node", args: ["server.mjs"] };
  svc.patch({ mcpServers: [good] });
  assert.deepEqual(svc.get().mcpServers, [good]);

  // 错误必须指出是哪一条，否则用户只看到「Expected array of MCP server configs」。
  assert.throws(
    () => svc.patch({ mcpServers: [good, { name: "Bad Name", command: "node" }] }),
    /mcpServers\[1\]\.name/,
  );
  assert.throws(() => svc.patch({ mcpServers: [good, { name: "b", command: "node", args: [1] }] }), /mcpServers\[1\]\.args/);
  assert.throws(() => svc.patch({ mcpServers: [good, good] }), /duplicated/);
  assert.throws(
    () => svc.patch({ mcpServers: Array.from({ length: MAX_MCP_SERVERS + 1 }, (_, i) => ({ name: `s${i}`, command: "node" })) }),
    /Too many/,
  );
  assert.deepEqual(
    svc.get().mcpServers,
    [good],
    "a rejected patch must not partially apply",
  );
});

test("持久化：落盘文件里的非法 mcpServers 只丢该字段，服务照常起来", () => {
  const file = join(tmpDir(), "settings.json");
  writeFileSync(
    file,
    JSON.stringify({ locale: "en-US", mcpServers: [{ name: "../evil", command: "node" }] }),
    "utf8",
  );
  // 与 server.ts 的装配一致：不传 sanitize 时构造会直接抛错（配置坏了就是死局）。
  const svc = new SettingsService(
    fileSettingsPort(file, { sanitize: (raw) => sanitizeSettings(raw).clean }),
  );
  assert.equal(svc.get().locale, "en-US", "the rest of the file must survive");
  assert.deepEqual(svc.get().mcpServers, [], "a hostile entry must not be kept");

  // 反向验证：没有清洗时同一份文件必须让构造失败，而不是静默加载。
  assert.throws(
    () => new SettingsService(fileSettingsPort(file)),
    /mcpServers\[0\]\.name/,
    "loading must not silently accept an invalid MCP server",
  );
});

test("设置：get() 深拷贝可变字段，外部改动污染不到内部状态", () => {
  const svc = new SettingsService(memorySettingsPort());
  svc.patch({ mcpServers: [{ name: "a", command: "node", env: { K: "v" } }] });
  const snapshot = svc.get();
  snapshot.mcpServers[0]!.name = "hacked";
  snapshot.mcpServers[0]!.env!.K = "hacked";
  assert.equal(svc.get().mcpServers[0]?.name, "a", "MCP config must not be mutable from outside");
  assert.equal(svc.get().mcpServers[0]?.env?.K, "v");
});

test("设置：setOnChange 在 patch 与 reset 后触发，回调抛错不影响已存设置", () => {
  const svc = new SettingsService(memorySettingsPort());
  const seen: number[] = [];
  svc.setOnChange((settings) => {
    seen.push(settings.mcpServers.length);
    throw new Error("listener blew up");
  });
  svc.patch({ mcpServers: [{ name: "a", command: "node" }] });
  assert.deepEqual(seen, [1]);
  assert.equal(
    svc.get().mcpServers.length,
    1,
    "a listener failure must not roll back settings that were already persisted",
  );
  svc.reset();
  assert.deepEqual(seen, [1, 0]);
});

test("持久化：写入是原子的（不留临时文件、不是截断态）", () => {
  const dir = tmpDir();
  const svc = new SettingsService(fileSettingsPort(join(dir, "settings.json")));
  svc.patch({ toolApprovalEnabled: true });

  const leftovers = readdirSync(dir).filter((n) => n.includes(".tmp"));
  assert.deepEqual(leftovers, [], "the temp file must be renamed away, not left behind");
  const parsed = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  assert.equal(parsed.toolApprovalEnabled, true);
});

test("持久化：非法设置值被拒且不改变已存状态（原子性）", () => {
  const file = join(tmpDir(), "settings.json");
  const svc = new SettingsService(fileSettingsPort(file));
  svc.patch({ contextKeepRecent: 9 });

  assert.throws(() => svc.patch({ contextKeepRecent: 9999 }));
  assert.throws(() => svc.patch({ unknownField: 1 }), /Unknown/);
  assert.equal(svc.get().contextKeepRecent, 9, "a rejected patch must not partially apply");
  assert.equal(new SettingsService(fileSettingsPort(file)).get().contextKeepRecent, 9);
});

test("持久化：审批规则落盘后重启不丢", () => {
  const file = join(tmpDir(), "rules.json");
  const store = new ApprovalRulesStore();
  store.upsert({
    id: "user-1",
    description: "禁止写生产配置",
    tools: ["write", "edit"],
    field: "path",
    match: { kind: "prefix", value: "/etc" },
    action: "deny",
  });
  saveApprovalRulesToFile(file, store.listUserRules());

  const reloaded = loadApprovalRulesFromFile(file);
  assert.equal(reloaded.listUserRules().length, 1);
  assert.equal(reloaded.listUserRules()[0]?.id, "user-1");
});

test("持久化：损坏的规则文件回落到内置规则（绝不等于全部放行）", () => {
  const file = join(tmpDir(), "rules.json");
  writeFileSync(file, "<<<not json>>>");
  const store = loadApprovalRulesFromFile(file);

  // 内置规则必须还在——否则一条坏文件就等于关掉全部高危拦截。
  assert.ok(store.rules().length > 0, "builtin rules must survive a corrupted file");
  assert.ok(
    store.rules().some((r) => r.action === "deny"),
    "hard denials must still be in force after falling back",
  );
});

test("持久化：畸形规则被逐条跳过，不影响合法规则", () => {
  const file = join(tmpDir(), "rules.json");
  writeFileSync(
    file,
    JSON.stringify({
      userRules: [
        { id: "ok", description: "合法", tools: ["bash"], field: "command", match: { kind: "contains", value: "ls" }, action: "ask" },
        { id: "bad-action", description: "动作非法", tools: ["bash"], field: "command", match: { kind: "regex", value: "x" }, action: "explode" },
        { id: "bad-match", description: "匹配非法", tools: ["bash"], field: "command", match: { kind: "wat", value: "x" }, action: "deny" },
        { id: "", description: "缺 id", tools: ["bash"], field: "command", match: { kind: "regex", value: "x" }, action: "deny" },
        "not-an-object",
      ],
    }),
  );
  const skipped: unknown[] = [];
  const store = loadApprovalRulesFromFile(file, { logger: (_m, err) => skipped.push(err) });

  assert.equal(store.listUserRules().length, 1, "only the well-formed rule survives");
  assert.equal(store.listUserRules()[0]?.id, "ok");
  assert.ok(skipped.length >= 4, "each malformed entry must be reported");
  assert.ok(store.rules().length > 1, "builtin rules remain in force");
});

/**
 * 回归：畸形规则的 `match.value` 曾不校验，后果是「加载时没事、审批时崩」或静默错配。
 *
 * `{kind:"glob"}` 缺 value →匹配时 `globToRegExp(undefined)` 抛错，
 *   即规则库把审批路径带崩；
 * `{kind:"regex"}` 缺 value → `new RegExp(undefined)` 匹配字面量 "undefined"，
 *   不崩但永远匹配错东西——比崩更危险，因为没人会发现。
 */
test("持久化：match 缺 value 的规则被拒绝（否则审批时崩或静默错配）", () => {
  const file = join(tmpDir(), "rules.json");
  writeFileSync(
    file,
    JSON.stringify({
      userRules: [
        { id: "no-value-glob", description: "缺 value", tools: ["bash"], field: "command", match: { kind: "glob" }, action: "deny" },
        { id: "no-value-regex", description: "缺 value", tools: ["bash"], field: "command", match: { kind: "regex" }, action: "deny" },
        { id: "empty-capability", description: "空 value", tools: ["*"], field: "params", match: { kind: "capability", value: "" }, action: "ask" },
        { id: "number-value", description: "value 非字符串", tools: ["bash"], field: "command", match: { kind: "prefix", value: 42 }, action: "ask" },
        { id: "bad-tools", description: "tools 含非字符串", tools: ["bash", 7], field: "command", match: { kind: "regex", value: "x" }, action: "deny" },
        { id: "good", description: "合法", tools: ["bash"], field: "command", match: { kind: "regex", value: "danger" }, action: "deny" },
      ],
    }),
  );
  const store = loadApprovalRulesFromFile(file);
  const ids = store.listUserRules().map((r) => r.id);
  assert.deepEqual(ids, ["good"], `only the well-formed rule may survive, got ${ids.join(",")}`);

  // 更关键：加载出来的规则在真正匹配时不能抛。
  const input = { toolName: "bash", args: { command: "danger --now" }, cwd: process.cwd(), capabilities: [] };
  const verdict = store.evaluate(input);
  assert.ok(verdict, "the surviving rule must still evaluate");
  assert.equal(verdict.action, "deny");
});

test("持久化：outside_workspace 规则不带 value 是合法的", () => {
  const file = join(tmpDir(), "rules.json");
  writeFileSync(
    file,
    JSON.stringify({
      userRules: [
        { id: "outside", description: "越界写入", tools: ["write"], field: "path", match: { kind: "outside_workspace" }, action: "ask" },
      ],
    }),
  );
  const store = loadApprovalRulesFromFile(file);
  assert.equal(store.listUserRules().length, 1, "outside_workspace needs no value");
});

test("持久化：规则文件不存在时只有内置规则", () => {
  const store = loadApprovalRulesFromFile(join(tmpDir(), "absent.json"));
  assert.equal(store.listUserRules().length, 0);
  assert.ok(store.rules().length > 0, "builtin rules are always present");
});

test("持久化：默认设置文件路径落在 agent 目录下", () => {
  const file = defaultSettingsFile();
  assert.ok(file.endsWith("pi-starter-settings.json"), file);
});