# 本地 git 钩子（提交前检查）

> 补上模板链条里**「提交时」**这一段 —— 模板原本只管「发版时」（`scripts/release.mjs` + workflow）与「本地全量门禁」（`scripts/verify.mjs`），但没有"每次 commit 顺手拦一道"的东西。
> 取材自腾讯 Octop（MIT）的 `.githooks/pre-commit`，做了通用化。

## 一、装（每个 clone 执行一次）

```bash
# 把仓库内的 hooks/ 目录设为 git 钩子目录
git config core.hooksPath hooks
```

用 `core.hooksPath` 而不是往 `.git/hooks/` 里拷，是因为 **`.git/` 不进版本控制** —— 放在仓库里的 `hooks/` 能跟着项目走，团队每个人一条命令就能启用同一套钩子。

**Windows 注意**：钩子是 bash 脚本，需要 Git for Windows 自带的 bash（装了 Git 就有）。若提示没有执行权限：

```bash
chmod +x hooks/pre-commit
git update-index --chmod=+x hooks/pre-commit   # 让 exec 位也进版本控制
```

## 二、它做什么（四步）

| 步骤 | 行为 | 为什么 |
|---|---|---|
| 1 | **纯文档改动直接放行** | 只改 `*.md` / 图片 / `LICENSE` 之类时，没必要跑代码检查 |
| 2 | **跑快速门禁**：读 `pipeline.config.json` 的 `precommit` 数组 | 提交要快；全量门禁留在 `verify` 数组与 CI 里。**没配 `precommit` 就跳过**，不会报错 |
| 3 | **把已暂存文件重新加入索引** | 第 2 步若含自动格式化，会改写工作区文件 → 这一步保证提交进仓库的是格式化后的内容（防 worktree/index 漂移） |
| 4 | 任一步失败 → 中断提交 | 门禁没过的提交留不下来 |

## 三、和模板其它部分的配合

```
提交时         hooks/pre-commit    ← 本目录（快：文档跳过 + precommit 数组）
本地全量门禁   scripts/verify.mjs  ← 发版前 / 手动跑（verify 数组）
CI 门禁        .github/workflows/ci.yml ← PR 上跑（见各 profiles 的 ci.yml）
发版           scripts/release.mjs + .github/workflows/publish.yml
```

**`precommit` 与 `verify` 的分工**：`verify` 是"发版前必须全绿"的全量门禁；`precommit` 是"提交前几秒钟能跑完"的子集（通常 = lint + 快速单测）。配置样例见 `pipeline.config.example.json`。

## 四、应急绕过

```bash
SKIP_PRECOMMIT=1 git commit -m "..."   # 只跳这一次
git commit --no-verify                 # git 原生绕过
```

两个都只跳过**本地**检查 —— CI 与发版门禁照样会拦。
