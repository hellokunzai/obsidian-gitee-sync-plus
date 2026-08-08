# Agent 指南(cc-obsidian-syn)

本仓库是 Obsidian 插件 **Gitee Sync Plus**(id: `gitee-sync-plus`):把 vault 以文件粒度同步到 Gitee/GitHub 仓库。三方对比同步引擎在 `src/sync.ts`,平台后端在 `src/githost.ts`,构建产物 `main.js` 不入库。

## 构建

```bash
npm install
npm run build     # tsc --noEmit + esbuild → main.js
```

改动后如需在本机 vault 验证:`cp main.js manifest.json <vault>/.obsidian/plugins/gitee-sync-plus/`,重启 Obsidian。

## 发布新版本(社区市场 / BRAT 的更新来源)

**必须使用发布脚本,不要手工拆步骤执行:**

```bash
scripts/release.sh <version> ["release notes"]
```

- 版本号 `x.y.z` 格式、不带 v 前缀、必须大于 manifest.json 当前版本;
- 脚本要求工作区干净:功能改动先单独提交,发布提交只含版本号变更;
- 脚本自动完成:bump manifest.json/versions.json → 构建 → 提交推送 → `gh release create`(标签与版本号一致,附 main.js + manifest.json);
- 若本次改动用到了更新的 Obsidian API,发布前先把 manifest.json 的 `minAppVersion` 提到对应版本——否则老版本 App 用户会拿到损坏的功能;提高 minAppVersion 的代价是低版本 App 用户被 versions.json 路由到旧插件版本,不要随意提高;
- 插件已上架官方社区市场,日常更新只需发 Release,无需重新提交门户审核。
