/**
 * pi-starter · 示例工具：db_status / db_query
 *
 * 打到 DatabaseStore。db_query 只跑只读 SELECT，参数走绑定，不拼接 SQL。
 */

import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { isReadOnlySql, type DatabaseStore } from "../db/index.js";

type DbQueryDetails = {
  ok: boolean;
  columns: string[];
  rowCount: number;
};

export function createDbStatusTool(database: DatabaseStore) {
  return defineTool({
    name: "db_status",
    label: "数据库探活",
    description: "检查数据库是否连通，返回 driver 和路径。用户问数据库连上了没、库在哪时使用。",
    parameters: Type.Object({}),
    async execute() {
      const ping = database.ping();
      return {
        content: [{ type: "text", text: `数据库连通：${ping.driver} ${ping.path}` }],
        details: ping,
      };
    },
  });
}

export function createDbQueryTool(database: DatabaseStore) {
  return defineTool({
    name: "db_query",
    label: "只读 SQL 查询",
    description:
      "对脚手架数据库执行一条 SELECT（可用 WITH）。查 notes 或其他表时使用。不能 INSERT/UPDATE/DELETE。",
    parameters: Type.Object({
      sql: Type.String({ description: "单条 SELECT 或 WITH … SELECT" }),
    }),
    async execute(_id, params: { sql: string }) {
      const fail = (text: string): { content: { type: "text"; text: string }[]; details: DbQueryDetails } => ({
        content: [{ type: "text", text }],
        details: { ok: false, columns: [], rowCount: 0 },
      });
      if (!isReadOnlySql(params.sql)) {
        return fail("只允许单条 SELECT / WITH…SELECT。");
      }
      try {
        const result = database.query(params.sql);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: {
            ok: true,
            columns: result.columns,
            rowCount: result.rows.length,
          },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return fail(`查询失败：${message}`);
      }
    },
  });
}
