# 更新日志

## 1.0.6（2026-08-13）

私人令牌改为通过「选择秘钥」对话框管理，并新增测试按钮。

- 新增 `src/token-manager.ts`：封装 `app.secretStorage` 操作；对话框数据源改为 `listSecrets()` 返回的 Obsidian 钥匙串全部 key
- `src/settings.ts`：
  - 私人令牌/访问令牌输入框替换为「选择秘钥」+「测试」两个按钮
  - 新增 `TokenSelectModal`：直接列出 Obsidian 钥匙串中的密钥，支持搜索、单选、添加新密钥、查看/隐藏、删除、保存
  - 测试按钮使用当前选中的密钥拉取分支列表，验证令牌是否可用
- `src/main.ts`：初始化 `TokenManager`；加载数据时从当前选中的 key 恢复内存中的 token，并自动把旧版单令牌设置迁移到钥匙串
- `src/githost.ts`：新增 `testToken()`，复用 `fetchBranches()` 验证令牌
- `src/i18n.ts`：新增选择秘钥、测试、添加/删除秘钥等相关文案（中/英）
- `styles.css`：新增「选择秘钥」对话框样式
- 版本号：`manifest.json` / `package.json` / `versions.json` → `1.0.6`

## 1.0.3（2026-08-11）

Git 面板增强与若干易用性修复。

- Git 面板三个分组（暂存区 / 更改 / 远端修改）支持折叠 / 展开
- 优化 Git 面板差异计算性能（远程 manifest 缓存、本地文件并发 hash、面板模式跳过昂贵冲突查询、刷新节流）
- 修复：设置页切换分支后 Git 面板标题与差异实时联动，无需重启
- 修复：设置页分支下拉框刷新后保留当前选择，不再跳回旧值

## 1.0.2（2026-08-09）

发布前合规审计与移动端兼容性修复。

---

### 一、移动端兼容性：SHA-1 改为纯 JS 实现（src/githost.ts）

**背景：** 原 `gitBlobSha1` 依赖 `crypto.subtle.digest`，在 Obsidian 移动端 webview（非安全上下文）中 `crypto.subtle` 可能为 `undefined`，导致同步在计算文件哈希时崩溃。插件 `isDesktopOnly: false`，必须保证移动端可用。

**改动：** 新增自包含纯 JS `sha1()`（严格按 Git blob 格式 `blob <size>\0<content>` 计算），经 `git hash-object` 端到端校验，空文件 / 含中文 emoji / 1MB 等用例与 Git 完全一致。

### 二、DiffView 插件实例获取方式加固（src/DiffView.ts, src/main.ts）

- 移除对未公开 API `app.plugins.getPlugin()` 的依赖，改为 `main.ts` 在 `onload()` 中通过 `setDiffPluginInstance()` 注入模块单例，保留回退路径；
- `RevertConfirmModal` 构造参数 `app: any` 收敛为 `App` 类型。

### 三、设置面板类型收敛（src/settings.ts）

- 分支下拉框 `dropdownComponent: any` 改为 `DropdownComponent`；
- 清空选项由 `selectEl.innerHTML = ""` 改为 Obsidian 提供的 `selectEl.empty()`。

### 四、版本映射与文档对齐

- `versions.json` 补齐 `1.0.1` / `1.0.2` 映射（均指向 `minAppVersion 1.8.7`），供 BRAT / 社区市场正确路由；
- `README.md` 中「排除目录」说明由「逗号分隔前缀」更正为「直接编辑 `.gitignore` 原始规则」，与设置界面一致。

### 五、CI 自动构建

仓库已包含 `.github/workflows/release.yml`：监听 tag 推送 → `npm install` + `npm run build` 生成 `main.js` → `gh release create` 发布 `main.js / manifest.json / styles.css`。后续发版只需打 tag 并推送，无需本地手工构建。

---

## 1.0.0（2026-08-08）

从 0.2.4 升级至 1.0.0，标记为新项目首个正式版本。本轮改动涵盖同步引擎重构、设置界面改版、插件改名三个主要方向，共 13 个文件、523 行新增、125 行删除。

---

### 一、同步引擎：.gitignore 替换硬编码过滤（a767fe8, 32b0d0b）

**背景：** 原先插件通过硬编码前缀列表排除文件（`.obsidian/`、`.git/` 等隐藏目录一律跳过），用户无法灵活控制排除规则。隐藏文件完全不同步导致 `.obsidian` 下的用户自定义配置无法跨设备同步。

**改动内容：**

1. **新增 `src/gitignore.ts`**（154 行）
   - 引入 `ignore` npm 包，实现标准 `.gitignore` 规则匹配
   - `GitIgnoreManager` 类负责 `.gitignore` 文件的读取、加载、写入
   - vault 根目录无 `.gitignore` 时自动创建默认文件，包含 `.git`、`_gitee-sync-plus-log.md`、`.trash`、`.obsidian/workspace.json`、`.obsidian/workspace-mobile.json` 等默认排除项
   - 维护插件管理的排除块（managed block），标记为 `# >>> gitee-sync-plus managed exclusions >>>` / `# <<< gitee-sync-plus managed exclusions <<<`，用户手动添加的规则不受影响

2. **`src/sync.ts` 全面改用 `vault.adapter`**
   - `buildLocalManifest()` 不再使用 `vault.getFiles()`（仅返回 Obsidian 索引的文件），改用新增的 `listAllFiles()` 递归列出所有文件（包括隐藏文件）
   - `listAllFiles()` 处理 Windows adapter 可能返回完整路径的情况，避免路径拼接错误
   - `writeLocal()`、`ensureFolder()` 改用 `adapter.writeBinary`、`adapter.exists`、`adapter.mkdir`，绕过 Obsidian 文件索引限制
   - `isExcluded()` 简化为 `gitIgnoreManager.isIgnored(path)`，删除了 `excludedPrefixes()` 和硬编码隐藏文件过滤
   - 删除本地文件改用 `adapter.remove()` 替代 `vault.trash()`，上传改用 `adapter.readBinary()` 替代 `vault.readBinary()`
   - `LocalEntry` 接口中 `file: TFile` 改为 `path: string`，不再依赖 Obsidian 文件对象

3. **`src/main.ts` 集成 GitIgnoreManager**
   - `onload()` 中初始化 `GitIgnoreManager`，调用 `ensureExists()` + `migrateLegacyExclusions()` + `load()`
   - `migrateLegacyExclusions()`：将旧的 `excludeFolders` 设置自动迁移到 `.gitignore` 管理块中，迁移后清空旧字段
   - 本地同步状态 key 从 `gitee-sync-sync-state-v1` 改为 `gitee-sync-plus-sync-state-v1`

4. **设置界面排除目录编辑器**（`src/settings.ts`）
   - 原 `excludeFolders` 文本输入框改为多行文本域（TextArea），直接显示和编辑 `.gitignore` 完整内容
   - 12 行高度、等宽字体、失去焦点时自动保存
   - `excludeFolders` 字段标记为 `@deprecated`，不再出现在 `DEFAULT_SETTINGS` 中

---

### 二、设置界面：分支动态下拉框 + 配置项顺序调整（94b2bf4, e8cedc6）

**背景：** 原先分支字段是纯文本输入框，用户需要手动输入分支名，容易拼错。设置项顺序也不统一（Gitee 和 GitHub 的 Token 位置不一致）。

**改动内容：**

1. **`src/githost.ts` 新增 `fetchBranches()` 函数**
   - 通过 Gitee/GitHub REST API 拉取仓库分支列表（`/repos/{owner}/{repo}/branches`）
   - Gitee 通过 URL 参数传 `access_token`，GitHub 通过 `Authorization: Bearer` header
   - 支持 per_page=100 分页参数
   - API 失败时抛出 `GitHostError`，附带状态码和详细信息

2. **`src/settings.ts` 新增分支下拉框组件**
   - `renderBranchSetting()` 方法统一渲染分支选择 UI：下拉框 + 刷新按钮
   - 分支缓存机制：`branchCache` Map + 5 分钟 TTL，避免频繁 API 调用
   - 初始渲染时：信息齐全且有缓存 → 直接填充缓存数据；无缓存 → 下拉框仅显示当前值，等用户点刷新
   - 点击刷新按钮：清缓存 → 拉 API → 填充选项 → 保留当前选择（若分支仍存在）
   - `display()` 从同步改为 `async display()`，因为需要异步读取 `.gitignore` 内容

3. **配置项顺序统一**
   - Gitee 和 GitHub 统一为：**私人令牌/Token → 用户名 → 仓库名 → 分支**
   - 任何字段变更后自动 `this.display()` 重新渲染，确保分支下拉框能及时更新

4. **i18n 新增文案**（`src/i18n.ts`）
   - `settingsBranchNeedInfo`：提示填写用户名、仓库名和令牌后可自动获取分支
   - `settingsBranchLoadFailed`：分支获取失败提示
   - `refreshBranches`：刷新按钮 tooltip

5. **第二次重构（e8cedc6）**
   - 去掉打开设置页时自动请求 API 的逻辑，改为点击刷新按钮才加载
   - 去掉 `disabled` 禁用态逻辑，未查询到分支时下拉框仅显示当前值（不灰禁）
   - 5 分钟内存缓存保留，刷新时清缓存后重新拉取

---

### 三、插件改名：Gitee Sync → Gitee Sync Plus（232ebfd）

**背景：** 与社区市场中其他同名插件区分，改为 Gitee Sync Plus，插件 ID 从 `gitee-sync` 改为 `gitee-sync-plus`。

**改动范围（10 个文件）：**

| 文件 | 改动内容 |
|------|----------|
| `manifest.json` | `id` → `gitee-sync-plus`，`name` → `Gitee Sync Plus` |
| `package.json` | `name` → `gitee-sync-plus`，新增 `ignore` 依赖 |
| `package-lock.json` | 同步更新 |
| `versions.json` | 重置为 `{"1.0.0": "1.8.7"}` |
| `README.md` | 标题、安装路径、说明文档全量替换 |
| `AGENTS.md` | 插件名、ID、安装路径替换 |
| `scripts/release.sh` | 插件目录路径替换 |
| `src/main.ts` | console 前缀 `[gitee-sync-plus]`，本地状态 key 替换 |
| `src/sync.ts` | 日志文件名 `_gitee-sync-plus-log.md` |
| `src/gitignore.ts` | 管理块标记 + 默认 `.gitignore` 内容中的文件名 |
| `src/i18n.ts` | 诊断日志标题中英文替换 |

> **⚠️ Breaking Change：** 已有用户的插件目录从 `.obsidian/plugins/gitee-sync/` 变为 `.obsidian/plugins/gitee-sync-plus/`，设置数据和同步基线不会自动迁移。用户需重新配置令牌和仓库信息。

---

### 四、版本号重置（461ff81）

`manifest.json` 版本从 `0.2.4` 重置为 `1.0.0`，`versions.json` 清空历史版本记录，仅保留 `"1.0.0": "1.8.7"`。标志新项目首个正式发布版本。

---

### 文件变更统计

```
 AGENTS.md          |   4 +-
 README.md          |  26 +++----
 manifest.json      |   6 +-
 package-lock.json  |  28 +++++--
 package.json       |   5 +-
 scripts/release.sh |   2 +-
 src/githost.ts     |  46 ++++++++++-
 src/gitignore.ts   | 154 +++++++++++++++++++++++++++++++++++++
 src/i18n.ts        |  19 +++--
 src/main.ts        |  21 ++++-
 src/settings.ts    | 220 +++++++++++++++++++++++++++++++++++++++++++----------
 src/sync.ts        | 110 +++++++++++++++++----------
 versions.json      |   7 +-
 13 files changed, 523 insertions(+), 125 deletions(-)
```

### 提交记录

| 提交 | 日期 | 说明 |
|------|------|------|
| `a767fe8` | 2026-08-07 | feat: 用 .gitignore 替换硬编码过滤，支持同步隐藏文件 |
| `32b0d0b` | 2026-08-07 | feat: 设置页排除目录改为直接编辑完整 .gitignore 内容 |
| `94b2bf4` | 2026-08-08 | feat: 分支选择改为动态下拉框，统一设置项顺序 |
| `e8cedc6` | 2026-08-08 | refactor: 分支下拉框改为点击刷新时加载，去掉禁用态 |
| `232ebfd` | 2026-08-08 | rename: 插件名称和 ID 改为 Gitee Sync Plus |
| `461ff81` | 2026-08-08 | chore: 版本号重置为 1.0.0 |
