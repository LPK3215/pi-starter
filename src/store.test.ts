/**
 * 持久化测试。
 *
 * 关注两类真实故障——它们决定了「落盘」是可靠还是反而制造了死局：
 *   1. **写到一半被杀** → 文件截断 → 下次启动读不回来（原子写要防的正是这个）；
 *   2. **文件损坏 / 内容不合 schema** → 必须回落可用默认值，而不是让服务起不来。
 *      审批规则更严格：一条畸形规则绝不能被当成「无规则」从而放行高危命令。
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  SettingsService,
  fileSettingsPort,
  defaultSettingsFile,
  SETTINGS_DEFAULTS,
} from "./settings.js";
import {
  ApprovalRulesStore,
  loadApprovalRulesFromFile,
  saveApprovalRulesToFile,
} from "./approval/rules.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-store-"));
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
  saveApprovalRulesToFile(file, store);

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

test("持久化：规则文件不存在时只有内置规则", () => {
  const store = loadApprovalRulesFromFile(join(tmpDir(), "absent.json"));
  assert.equal(store.listUserRules().length, 0);
  assert.ok(store.rules().length > 0, "builtin rules are always present");
});

test("持久化：默认设置文件路径落在 agent 目录下", () => {
  const file = defaultSettingsFile();
  assert.ok(file.endsWith("pi-starter-settings.json"), file);
});