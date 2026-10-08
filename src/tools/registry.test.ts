/**
 * 运行期增删工具（注册表）测试。
 *
 * `unregister` 存在的唯一理由：MCP 服务器下线后，它贡献的工具必须一起消失。
 * 只测「注册得进去」是不够的——留着一条调不通的工具条目，模型会一直去试，
 * 而目录里看不出任何异常，所以这里专门测删除路径（含 order 不泄漏）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolRegistry, defineToolSpec } from "./registry.js";

test("注册表：注销会清掉启用态与顺序，不会留下叫不应的条目", () => {
  const registry = createToolRegistry({ builtinTools: ["read"] });
  registry.register(
    defineToolSpec({
      name: "mcp__a__x",
      description: "a",
      source: "dynamic",
      capabilities: ["mcp"],
      origin: "mcp:a",
    }),
  );
  registry.register(
    defineToolSpec({
      name: "mcp__b__y",
      description: "b",
      source: "dynamic",
      capabilities: ["mcp"],
      origin: "mcp:b",
    }),
  );
  assert.equal(registry.catalog().length, 3, "one builtin + two MCP tools");

  assert.equal(registry.unregister("mcp__a__x"), true);
  assert.equal(registry.unregister("mcp__a__x"), false, "removing twice must be a no-op, not a throw");
  assert.equal(registry.has("mcp__a__x"), false);
  assert.deepEqual(
    registry.catalog().map((tool) => tool.name),
    ["read", "mcp__b__y"],
    "a removed tool must not linger in the catalog",
  );

  // 反向验证：反复注册/注销不能让内部顺序数组单调增长。
  for (let i = 0; i < 50; i += 1) {
    registry.register(defineToolSpec({ name: "tmp", description: "t", source: "dynamic", origin: "mcp:b" }));
    registry.unregister("tmp");
  }
  assert.deepEqual(
    registry.catalog().map((tool) => tool.name),
    ["read", "mcp__b__y"],
    "churn must not accumulate entries",
  );
});

test("注册表：按来源批量摘除只影响该来源", () => {
  const registry = createToolRegistry({ builtinTools: ["read"] });
  registry.register(
    defineToolSpec({ name: "mcp__a__1", description: "1", source: "dynamic", origin: "mcp:a" }),
  );
  registry.register(
    defineToolSpec({ name: "mcp__a__2", description: "2", source: "dynamic", origin: "mcp:a" }),
  );
  registry.register(
    defineToolSpec({ name: "mcp__b__1", description: "3", source: "dynamic", origin: "mcp:b" }),
  );
  const removed = registry.unregisterWhere((spec) => spec.origin === "mcp:a");
  assert.deepEqual(removed.sort(), ["mcp__a__1", "mcp__a__2"]);
  assert.deepEqual(
    registry.catalog().map((tool) => tool.name),
    ["read", "mcp__b__1"],
    "one server going down must not take the others with it",
  );
});

test("注册表：重新注册同名工具会替换描述而不是并存两条", () => {
  const registry = createToolRegistry();
  registry.register(defineToolSpec({ name: "dup", description: "old", source: "dynamic" }));
  registry.register(defineToolSpec({ name: "dup", description: "new", source: "dynamic" }));
  assert.equal(registry.catalog().length, 1);
  assert.equal(registry.get("dup")?.description, "new");
});