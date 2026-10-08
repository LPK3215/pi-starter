/**
 * pi-starter · 审批规则编辑接口
 *
 * 此前规则「能读能落盘，但没有编辑入口」——全仓库 upsert/remove 只在测试里被调用，
 * 规则只能手改 JSON；而落盘只在优雅停机时发生，于是运行期间的手改会被停机写回覆盖。
 * 本模块补上编辑入口，并把落盘时机改为「改动即写」，那个覆盖问题随之消失。
 *
 * 安全：这些端点能改变**审批策略**，因此
 *   1. 每条规则都过 `validateApprovalRule`（含 match.value 必须是非空字符串），
 *      与加载磁盘文件时用的是同一套校验——不能出现「手写文件会被拦、API 就能塞进去」；
 *   2. 规则条数有上限（与内置规则叠加后仍有限），避免规则库被撑爆；
 *   3. 内置规则**不可删**（builtin 标记），只能被用户规则覆盖。
 */

import type { Express, Request, Response } from "express";
import { AppError, badRequest, validationFailed } from "./errors.js";
import { asyncRoute } from "./routes.js";
import {
  validateApprovalRule,
  MAX_USER_RULES,
  type ApprovalRulesStore,
} from "../approval/rules.js";

export interface ApprovalRoutesOptions {
  /** 提供后才注册这些路由——改审批策略是敏感能力，不该默认开启。 */
  store?: ApprovalRulesStore;
}

export function registerApprovalRoutes(app: Express, options: ApprovalRoutesOptions = {}): void {
  const store = options.store;
  if (!store) return;

  /** 列出规则：生效的全集（用户在前）+ 是否内置标记。 */
  app.get("/approval/rules", (_req: Request, res: Response) => {
    res.json({
      rules: store.rules().map((rule) => ({ ...rule, builtin: rule.builtin === true })),
      userCount: store.listUserRules().length,
    });
  });

  /** 整体替换用户规则。 */
  app.put(
    "/approval/rules",
    asyncRoute(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as { rules?: unknown };
      if (!Array.isArray(body.rules)) throw badRequest("rules 必须是数组");
      if (body.rules.length > MAX_USER_RULES) {
        throw validationFailed(`用户规则不得超过 ${MAX_USER_RULES} 条`);
      }
      const validated = body.rules.map(validateApprovalRule);
      // 内置规则不该出现在用户规则里：它是只读的系统预置。
      if (validated.some((rule) => rule.builtin)) {
        throw validationFailed("内置规则不可通过此接口写入");
      }
      // 整体替换时也逐条校验 id 合法（与单条路径同一标准）。
      store.setUserRules(validated);
      res.json({ ok: true, userCount: store.listUserRules().length });
    }),
  );

  /** 新增 / 覆盖单条规则（同 id 覆盖）。 */
  app.post(
    "/approval/rules",
    asyncRoute(async (req: Request, res: Response) => {
      const rule = validateApprovalRule(req.body);
      if (rule.builtin) throw validationFailed("内置规则不可通过此接口写入");
      if (
        !store.listUserRules().some((item) => item.id === rule.id) &&
        store.listUserRules().length >= MAX_USER_RULES
      ) {
        throw validationFailed(`用户规则不得超过 ${MAX_USER_RULES} 条`);
      }
      store.upsert(rule);
      res.json({ ok: true, rule });
    }),
  );

  /** 删除一条用户规则。 */
  app.delete(
    "/approval/rules/:id",
    asyncRoute(async (req: Request, res: Response) => {
      const id = String(req.params.id ?? "").trim();
      if (!id) throw badRequest("缺少规则 id");
      const target = store.listUserRules().find((item) => item.id === id);
      if (!target) throw new AppError("not_found", `规则不存在：${id}`);
      if (target.builtin) throw validationFailed("内置规则不可删除");
      store.remove(id);
      res.json({ ok: true, removed: id });
    }),
  );
}
