# 项目记忆: gitee-sync-plus (Obsidian 插件 Gitee Sync Plus)

## 提交 Obsidian 社区市场 / 第三方市场的合规要点
- 移动端（`isDesktopOnly: false`）不可用 `crypto.subtle`（非安全上下文可能为 undefined）。文件哈希用 `src/githost.ts` 中的纯 JS `sha1`（git blob 格式：`sha1("blob <size>\0<content>")`）。
- `versions.json` 必须为**每个发布版本**保留条目，且版本号与 `manifest.json` 一致；缺条目会导致 BRAT/市场无法识别该版本的 `minAppVersion`。
- README 文案须与设置 UI 一致：排除规则现为 vault 根 `.gitignore` 原始编辑器（**不是**逗号分隔前缀）。
- `DiffView` 经 `main.ts` 的 `setDiffPluginInstance` 注入插件实例，勿依赖未公开 API `app.plugins.getPlugin`。
- **发布走 GitHub Actions 自动构建（当前实际流程）**：`manifest.json` + `versions.json` 提升版本并 commit 后，打 tag（如 `1.0.2`，不带 v 前缀）并 `git push github <tag>` 即触发 `.github/workflows/release.yml`（`on: push: tags: '*'`）→ `npm install` + `npm run build` 生成 `main.js` → `gh release create` 发布 `main.js / manifest.json / styles.css`。**不再手工跑 `scripts/release.sh`**（与 Actions 重复）。`main.js` 不入库，由 CI 构建。
- 远端配置：`github` = `git@github.com-hellokunzai:hellokunzai/obsidian-gitee-sync-plus.git`（SSH 别名 `github.com-hellokunzai` → `ssh.github.com:443`，可穿透受限网络，已验证可用）；`origin` = 上游 fork `ericquan8/obsidian-gitee-sync`，勿动。
- `main.js` / `styles.css` 经 Release 资产分发；仓库内通常不提交 `main.js`（见 AGENTS.md）。
- 死命令（全局）：未经用户明确说「git 提交」，绝不执行 git commit。
