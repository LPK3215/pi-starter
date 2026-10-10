/**
 * pi-starter · 覆盖率棘轮阈值的唯一声明处
 *
 * 单独成模块的原因：`scripts/coverage.mjs` 顶层就会 spawn 整个测试套件，任何想复用这个数字的
 * 脚本（比如文档生成器）都不能 `import` 它。阈值同时被门禁和 README / 全景页引用，
 * 所以它必须有一份、且只有这一份字面量。
 *
 * **棘轮（ratchet）**：阈值定在当前实测值下方一点，只允许往上调。调高之前先跑一次看真实数字。
 */
export const THRESHOLDS = { lines: 92, branches: 81, functions: 85 };
