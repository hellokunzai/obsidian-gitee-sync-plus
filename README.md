# Gitee Sync Plus

[English](#english) | [中文](#中文)

## English

Gitee Sync Plus stores an Obsidian vault as ordinary files in a private **Gitee or GitHub repository**. It connects directly to the platform API, requires no server or local Git installation, and works on desktop, iOS, and Android.

The sync engine uses Git blob hashes and a three-way comparison between the local vault, remote repository, and the last successful device-local baseline. It supports incremental two-way sync, deletion propagation, conflict resolution, dry-run previews, and diagnostic logs. When both sides modify the same file, the newer modification wins.

The plugin interface automatically follows Obsidian's language and currently supports English and Chinese.

### Installation

In Obsidian, open **Settings → Community plugins → Browse**, search for **Gitee Sync Plus**, install it, and enable it.

For local development builds:

```bash
npm install
npm run build

mkdir -p "<vault>/.obsidian/plugins/gitee-sync-plus"
cp main.js manifest.json "<vault>/.obsidian/plugins/gitee-sync-plus/"
```

### Repository and token

**Gitee:** Create a private repository. In **Settings → Security Settings → Personal access tokens**, create a token with the **projects** permission.

**GitHub:** Create a private repository. A fine-grained personal access token needs **Contents: Read and write** access to the repository; a classic token needs the `repo` scope.

### Configuration

| Setting | Description |
|---|---|
| Storage backend | Gitee repository or GitHub repository |
| Owner | User or organization from the repository URL |
| Repository | Private repository used for the vault |
| Branch | Gitee defaults to `master`; GitHub defaults to `main` |
| Token | Managed personal access tokens. Click **Select token** to add or choose a saved token; click **Test** to verify it. |
| Automatic sync interval | Minutes between syncs; `0` disables automatic sync |
| Sync on startup | Runs one sync when Obsidian opens |
| Excluded paths | Raw `.gitignore` rules at the vault root; edits take effect on the next sync |
| Diagnostic log | Writes the sync plan and result to `_gitee-sync-plus-log.md` |

Trigger sync from the ribbon icon, the **Sync now** command, the status bar, the timer, or startup sync. Use **Preview sync plan** to inspect planned actions without changing either side.

### Multiple devices

Install and configure the plugin on every device with the same repository. Each device keeps its own sync baseline. A new device downloads the remote vault on its first sync and uses incremental sync afterwards.

Mobile operating systems suspend timers in the background, so enabling **Sync on startup** is recommended.

### iOS file visibility

If a downloaded folder is visible but a file with a non-standard extension is not, open **Settings → Files and links** and enable **Detect all file extensions**. The file may already be present but hidden by Obsidian's file explorer.

### Sync behavior

- Local-only changes are uploaded; remote-only changes are downloaded.
- Deletions propagate in both directions. Local deletions use Obsidian's trash, and remote history remains recoverable through Git.
- If both sides modify the same file, the newer modification wins. A modification wins over a deletion.
- Hidden paths such as `.obsidian` and `.git` are ignored on both sides.
- Sync stops if the remote platform returns a truncated file tree, preventing accidental mass deletion.
- Every uploaded or deleted file creates a repository commit, so previous versions remain recoverable.

### Limitations and security

- The first sync of a large vault creates one commit per file and may be limited by platform API quotas.
- Keep large attachments in an excluded folder. Individual files should preferably remain below 50 MB.
- Tokens are stored in the Obsidian Secret Storage (Settings → Secrets), no longer in `data.json`. No need to exclude anything when backing up the vault with other tools.
- Do not manually push the same vault to the same repository while the plugin manages it.

## 中文

Gitee Sync Plus 将 Obsidian vault 中的笔记以普通文件形式保存到私有 **Gitee 或 GitHub 仓库**。插件直接连接平台 API，无需服务器或本地安装 Git，并支持桌面端、iOS 和 Android。

同步引擎使用 Git blob 内容哈希，对本地 vault、远端仓库和每台设备上次成功同步的基线进行三方比较。支持双向增量同步、删除同步、冲突处理、同步预演和诊断日志。两端同时修改同一文件时，保留修改时间较新的版本。

插件界面会自动跟随 Obsidian 的语言，目前支持中文和英语。

### 安装

在 Obsidian 中打开 **设置 → 第三方插件 → 浏览**，搜索 **Gitee Sync Plus**，安装并启用插件。

本地开发版本可手动构建安装：

```bash
npm install
npm run build

mkdir -p "<vault>/.obsidian/plugins/gitee-sync-plus"
cp main.js manifest.json "<vault>/.obsidian/plugins/gitee-sync-plus/"
```

### 仓库和令牌

**Gitee：** 创建私有仓库，然后在 **设置 → 安全设置 → 私人令牌** 中创建令牌，并勾选 **projects** 权限。

**GitHub：** 创建私有仓库。Fine-grained token 需要目标仓库的 **Contents: Read and write** 权限；classic token 需要勾选 `repo`。

### 配置

| 设置项 | 说明 |
|---|---|
| 存储后端 | Gitee 仓库或 GitHub 仓库 |
| 用户名 | 仓库 URL 中的用户或组织名 |
| 仓库名 | 用于保存 vault 的私有仓库 |
| 分支 | Gitee 默认 `master`，GitHub 默认 `main` |
| 令牌 | 已保存的私人访问令牌。点击「选择秘钥」添加或选择，点击「测试」验证是否可用。 |
| 自动同步间隔 | 同步间隔分钟数，`0` 表示关闭 |
| 启动时同步 | Obsidian 打开后执行一次同步 |
| 排除路径 | vault 根目录 `.gitignore` 原始规则，下次同步时生效 |
| 调试日志 | 将同步计划和结果写入 `_gitee-sync-plus-log.md` |

可通过侧边栏同步图标、命令面板中的 **立即同步**、状态栏、定时器或启动时同步触发。使用 **预览同步计划** 可以在不修改两端文件的情况下检查计划动作。

### 多设备

在每台设备安装插件并配置同一仓库。每台设备分别保存同步基线。新设备首次同步会下载远端 vault，之后只进行增量同步。

移动端进入后台后，系统可能暂停定时器，建议开启 **启动时同步**。

### iOS 文件显示

如果同步后能看到新目录，却看不到某些非标准扩展名文件，请打开 **设置 → 文件与链接 → 检测所有文件扩展名**。文件可能已经下载，只是被 Obsidian 文件列表隐藏。

### 同步规则

- 只在本地修改的文件会上传，只在远端修改的文件会下载。
- 删除会双向传播。本地删除进入 Obsidian 回收站，远端文件仍可通过 Git 历史恢复。
- 两端同时修改同一文件时，保留修改时间较新的版本；修改优先于删除。
- `.obsidian`、`.git` 等隐藏路径在两端都会被忽略。
- 远端平台返回被截断的文件树时会中止同步，避免误判为批量删除。
- 每次文件上传或删除都会生成仓库 commit，旧版本可随时恢复。

### 限制与安全

- 大型 vault 首次同步会逐文件生成 commit，可能受到平台 API 限流影响。
- 建议将大附件放入排除目录，单文件尽量保持在 50 MB 以下。
- 令牌存入 Obsidian 钥匙串（设置 → 钥匙串），不再保存在 `data.json` 中。使用其他工具备份 vault 时无需特别排除令牌。
- 插件管理仓库后，不要同时把同一个 vault 手动推送到相同仓库。
