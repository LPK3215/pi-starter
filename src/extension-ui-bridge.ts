/**
 * pi-starter · HITL 反问桥（官方 ExtensionUIContext 的 WS 实现）
 *
 * 官方 SDK 提供 `ctx.ui.input()/select()/confirm()` 这套反问人类的**接口**，但只给
 * 两种运行模式配了"谁来回答"：终端 TUI 与 RPC 子进程（stdin/stdout）。本项目把 session
 * 跑在进程内、靠 WebSocket 跟浏览器通信，是官方没附带实现的模式——所以这里实现官方
 * 的 `ExtensionUIContext`，把对话框按官方 `extension_ui_request` 线形推到 WS，等客户端
 * 回 `extension_ui_response` 再唤醒。语义逐字对齐官方 rpc-mode 的 `createDialogPromise`。
 *
 * 关键设计（与审批闸门 gate.ts 同源）：
 *   1. **超时 / 断开即默认值（fail-safe）**：人类不响应、或 emit 抛错（连接已断），
 *      对话框返回官方规定的默认值（select/input/editor→undefined、confirm→false），
 *      绝不永久阻塞工具。定时器**刻意不 unref**，空闲时也必须触发。
 *   2. 决策与传输分离：`uiContext` 只负责发请求；`resolve(id, response)` 由传输层在
 *      收到应答时回调，按 id 命中挂起请求。
 *   3. 只搬运脚手架需要的子集（四类对话框 + notify）；官方 `setStatus/setWidget/setTitle`
 *      等 fire-and-forget 方法与全部 TUI 专属方法降级为 no-op/默认值——与官方 RPC 模式
 *      的降级完全一致，故不占 WS 帧。
 */

import { randomUUID } from "node:crypto";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { UiExtensionRequest, UiExtensionResponse } from "./protocol.js";

export interface ExtensionUiBridge {
  /** 交给 `session.bindExtensions({ uiContext })` 的官方接口实现。 */
  readonly uiContext: ExtensionUIContext;
  /**
   * 传输层收到 `extension_ui_response` 时回调：按 id 命中挂起请求并唤醒。
   * 未知 id（已超时 / 已回收 / 伪造）返回 false，调用方据此回一帧提示。
   */
  resolve(id: string, response: UiExtensionResponse): boolean;
  /** 当前等待人类应答的请求数（用于观测与"等待中工具"豁免判断）。 */
  readonly pendingCount: number;
  /** 连接断开 / 会话回收时调用：把所有挂起请求按默认值解除，避免工具永久阻塞。 */
  dispose(): void;
}

/** 一个挂起对话框的唤醒器——收到应答、超时、断开三条路径都汇聚到它。 */
type Settler = (response: UiExtensionResponse) => void;

export interface ExtensionUiBridgeOptions {
  /** id 生成器，测试可注入固定序列。默认 `crypto.randomUUID`。 */
  newId?: () => string;
}

/**
 * 创建一个 WS 版扩展 UI 桥。
 *
 * @param emit 把一帧 `UiExtensionRequest` 推给客户端。抛错视为连接已断，按默认值解除。
 */
export function createExtensionUiBridge(
  emit: (request: UiExtensionRequest) => void,
  options: ExtensionUiBridgeOptions = {},
): ExtensionUiBridge {
  const newId = options.newId ?? (() => randomUUID());
  const pending = new Map<string, Settler>();
  let disposed = false;

  /**
   * 镜像官方 `createDialogPromise`：分配 id → 注册唤醒器 → 发请求 → 等应答；
   * timeout / signal 到点用 `cancelled` 应答兜底（各方法据此回默认值）。
   */
  function dialog<T>(
    build: (id: string) => UiExtensionRequest,
    opts: ExtensionUIDialogOptions | undefined,
    defaultValue: T,
    parse: (response: UiExtensionResponse) => T,
  ): Promise<T> {
    if (disposed) return Promise.resolve(defaultValue);
    if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

    const id = newId();
    return new Promise<T>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        opts?.signal?.removeEventListener("abort", onAbort);
        pending.delete(id);
      };
      const settle: Settler = (response) => {
        cleanup();
        resolve(parse(response));
      };
      const onAbort = () => settle({ id, cancelled: true });
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      // 刻意不 unref()：与审批闸门同理，事件循环空闲时它必须能触发，否则工具永久挂起。
      if (opts?.timeout) timer = setTimeout(() => settle({ id, cancelled: true }), opts.timeout);
      pending.set(id, settle);
      try {
        emit(build(id));
      } catch {
        // 传输已断：不能把对话框晾在半空，按取消解除。
        settle({ id, cancelled: true });
      }
    });
  }

  const parseValue = (r: UiExtensionResponse): string | undefined =>
    "cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined;
  const parseConfirm = (r: UiExtensionResponse): boolean =>
    "cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false;

  // 完整实现官方接口的每个成员（缺一个方法，SDK 内部一旦调用就是 "not a function"），
  // 再 cast 满足 bindExtensions 的类型——TUI 专属成员按官方 RPC 模式一律降级。
  const uiContext = {
    select: (title: string, options: string[], opts?: ExtensionUIDialogOptions) =>
      dialog((id) => ({ id, method: "select", title, options, timeout: opts?.timeout }), opts, undefined, parseValue),
    confirm: (title: string, message: string, opts?: ExtensionUIDialogOptions) =>
      dialog((id) => ({ id, method: "confirm", title, message, timeout: opts?.timeout }), opts, false, parseConfirm),
    input: (title: string, placeholder?: string, opts?: ExtensionUIDialogOptions) =>
      dialog((id) => ({ id, method: "input", title, placeholder, timeout: opts?.timeout }), opts, undefined, parseValue),
    editor: (title: string, prefill?: string) =>
      dialog((id) => ({ id, method: "editor", title, prefill }), undefined, undefined, parseValue),
    notify: (message: string, notifyType?: "info" | "warning" | "error") => {
      try {
        emit({ id: newId(), method: "notify", message, notifyType });
      } catch {
        /* fire-and-forget：连接断了就静默丢弃。 */
      }
    },

    // —— 以下为脚手架不渲染的成员，全部 no-op / 返回默认值（对齐官方 RPC 模式）——
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    onTerminalInput: () => () => {},
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme: {},
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Theme switching not supported over the WS bridge" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  } as unknown as ExtensionUIContext;

  return {
    uiContext,
    resolve(id, response) {
      const settle = pending.get(id);
      if (!settle) return false;
      settle(response);
      return true;
    },
    get pendingCount() {
      return pending.size;
    },
    dispose() {
      disposed = true;
      for (const settle of Array.from(pending.values())) settle({ id: "", cancelled: true });
      pending.clear();
    },
  };
}
