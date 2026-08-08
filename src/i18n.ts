import { getLanguage } from "obsidian";

const en = {
	clickToSync: "Click to sync with the remote repository",
	ribbonSync: "Sync with remote repository",
	commandSyncNow: "Sync now",
	commandPreview: "Preview sync plan (no changes; writes to diagnostic note)",
	statusIdle: "Sync: idle",
	statusRunning: "Sync: in progress…",
	statusComplete: (time: string) => `Sync: ${time} complete`,
	statusFailed: "Sync: failed",
	syncInProgress: "Sync is already in progress",
	syncFailed: (message: string) => `Sync failed: ${message}`,
	previewWhileSyncing: "Sync is in progress. Try the preview again later.",
	previewComplete: (pulled: number, pushed: number, deletedLocal: number, deletedRemote: number, file: string) =>
		`Preview complete: download ${pulled}, upload ${pushed}, delete local ${deletedLocal}, ` +
		`delete remote ${deletedRemote} (see ${file})`,
	previewFailed: (message: string) => `Preview failed: ${message}`,
	previewFailedLog: (time: string, message: string) =>
		`\n## Sync preview failed ${time}\n${message}\n`,
	diagnosticLogTitle: "# Gitee Sync Plus diagnostic log\n",
	summaryUpload: (count: number) => `uploaded ${count}`,
	summaryDownload: (count: number) => `downloaded ${count}`,
	summaryDeleteRemote: (count: number) => `deleted remote ${count}`,
	summaryDeleteLocal: (count: number) => `deleted local ${count}`,
	summaryConflict: (count: number) => `conflicts (newer version won) ${count}`,
	summaryComplete: (parts: string) => `Sync complete: ${parts}`,
	summaryNoChanges: "Sync complete: no changes",

	missingGithubSettings: "Enter the GitHub owner, repository, and access token in settings first.",
	missingGiteeSettings: "Enter the Gitee owner, repository, and personal access token in settings first.",
	apiFailed: (host: string, method: string, status: number, detail: string) =>
		`${host} API ${method} failed (${status}): ${detail}`,
	remoteTreeTruncated:
		"The remote file tree was truncated because it is too large. Sync was stopped to prevent accidental deletion.",
	deleteNeedsSha: (path: string) => `Deleting ${path} requires the remote SHA.`,
	commitAdd: (path: string) => `sync: add ${path}`,
	commitUpdate: (path: string) => `sync: update ${path}`,
	commitDelete: (path: string) => `sync: delete ${path}`,
	commitBatch: (uploaded: number, deleted: number) =>
		`sync: batch — ${uploaded} updated${deleted ? `, ${deleted} deleted` : ""}`,
	batchCommitFailed: (uploaded: number, deleted: number, message: string) =>
		`Batch commit failed (${uploaded} files to update, ${deleted} to delete): ${message}`,

	settingsBackend: "Storage backend",
	settingsBackendDesc:
		"After switching backends, the next sync performs a full reconciliation and keeps the newer modification.",
	optionGitee: "Gitee repository",
	optionGithub: "GitHub repository",
	settingsGiteeOwner: "Gitee owner",
	settingsGithubOwner: "GitHub owner",
	settingsOwnerDesc: "User or organization that owns the repository, as shown in its URL.",
	settingsRepo: "Repository name",
	settingsRepoDesc: "A dedicated private repository is recommended.",
	settingsBranch: "Branch",
	settingsBranchNeedInfo: "Fill in owner, repository, and token to auto-populate branches.",
	settingsBranchLoadFailed: "Failed to fetch branches. Check owner, repository, and token.",
	refreshBranches: "Refresh branches",
	settingsGiteeToken: "Personal access token",
	settingsGiteeTokenDesc:
		"Gitee Settings → Security Settings → Personal access tokens; enable the projects permission.",
	settingsGithubToken: "Access token",
	settingsGithubTokenDesc:
		"GitHub Settings → Developer settings → Personal access tokens; fine-grained tokens need Contents read/write permission for the repository (classic tokens need repo).",
	settingsAutoSync: "Automatic sync interval (minutes)",
	settingsAutoSyncDesc: "Enter 0 to disable automatic sync.",
	settingsSyncOnStart: "Sync on startup",
	settingsSyncOnStartDesc: "Run one sync after Obsidian starts.",
	settingsExcludeFolders: "Excluded folders",
	settingsExcludeFoldersDesc:
		"Raw contents of .gitignore at the vault root. Edit the rules here; they take effect on the next sync. Changes are saved when the field loses focus.",
	settingsDebugLog: "Diagnostic log",
	settingsDebugLogDesc:
		"Record each sync plan and result in _gitee-sync-plus-log.md at the vault root. The log should be excluded from sync via .gitignore.",
	settingsCommitMode: "Commit mode",
	settingsCommitModeDesc:
		"Choose whether each file gets its own commit or all changes are combined into a single commit.",
	optionPerFile: "One commit per file",
	optionBatch: "One commit for all changes (batch)",

	previewTitle: "Sync preview (not executed)",
	executionTitle: "Sync execution",
	pathFailed: (path: string, message: string) => `Failed to process \"${path}\": ${message}`,
	resultFailed: (message: string) => `Result: **Failed** — ${message}\n`,
	completedCounts: (pulled: number, pushed: number, deletedLocal: number, deletedRemote: number) =>
		`(Completed: downloaded ${pulled}, uploaded ${pushed}, deleted local ${deletedLocal}, ` +
		`deleted remote ${deletedRemote})\n`,
	resultSuccess: (pulled: number, pushed: number, deletedLocal: number, deletedRemote: number, conflicts: number) =>
		`Result: success — downloaded ${pulled}, uploaded ${pushed}, deleted local ${deletedLocal}, ` +
		`deleted remote ${deletedRemote}, conflicts ${conflicts}\n`,
	reasonLocalAdded: "Added locally",
	reasonLocalModified: "Modified locally",
	reasonLocalDeleted: "Deleted locally",
	reasonRemoteAdded: "Added remotely",
	reasonRemoteModified: "Modified remotely",
	reasonRemoteDeleted: "Deleted remotely",
	reasonConflictLocalNewer: (local: string, remote: string) =>
		`Conflict: local is newer (local ${local} ≥ remote ${remote})`,
	reasonConflictRemoteNewer: (remote: string, local: string) =>
		`Conflict: remote is newer (remote ${remote} > local ${local})`,
	reasonConflictKeepLocal: "Conflict: remote was deleted but local was modified; keep local",
	reasonConflictKeepRemote: "Conflict: local was deleted but remote was modified; keep remote",
	planBackend: (target: string) => `Backend: ${target}`,
	planCounts: (local: number, remote: number, base: number, unchanged: number, conflicts: number) =>
		`Local ${local} | Remote ${remote} | **Baseline ${base}** | Unchanged ${unchanged} | Conflicts ${conflicts}`,
	planNoActions: "Plan: both sides already match; no action needed",
	planActions: (pulled: number, pushed: number, deletedLocal: number, deletedRemote: number) =>
		`Plan: download ${pulled}, upload ${pushed}, delete local ${deletedLocal}, delete remote ${deletedRemote}`,
	actionDownload: "Download",
	actionDeleteLocal: "Delete local",
	actionUpload: "Upload",
	actionDeleteRemote: "Delete remote",
	unknown: "Unknown",

	panelTitle: "Git panel",
	panelRibbon: "Open Gitee Sync Plus Git panel",
	panelOpenCommand: "Open Git panel",
	panelMessagePlaceholder: "Commit message (applies to batch mode)…",
	panelCommitHint: "In per-file mode each file keeps its own message; the text above applies to batch commits.",
	panelCommit: "Commit",
	panelPull: "Pull",
	panelRefresh: "Refresh",
	panelGroupLocal: "Local changes",
	panelGroupRemote: "Remote changes",
	panelGroupEmpty: "Nothing here",
	panelNoChanges: "No changes — everything is in sync",
	panelStatusComputing: "Computing…",
	panelStatusWorking: "Working…",
	panelStatusChanges: (n: number) => `${n} change(s)`,
	panelStatusError: (msg: string) => `Error: ${msg}`,
	panelDiscard: "Discard",
	panelDiscardAll: "Discard all",
	panelDiscardConfirmTitle: "Discard local changes?",
	panelDiscardConfirm: (path: string) =>
		`Discarding changes to "${path}" will replace it with the remote version (or delete it if it only exists locally). This cannot be undone.`,
	panelDiscardAllConfirm: (n: number) =>
		`Discard all ${n} local change(s)? Modified files are replaced by the remote version; new local files are deleted. This cannot be undone.`,
	panelDiscarded: (n: number) => `Discarded ${n} change(s)`,
	panelDiscardFailed: (msg: string) => `Discard failed: ${msg}`,
	panelClickToDiff: "Click to view diff",
	panelGroupStaged: "Staged changes",
	panelGroupUnstaged: "Changes",
	panelStage: "Stage this file",
	panelUnstage: "Unstage this file",
	panelStageAll: "Stage all",
	panelUnstageAll: "Unstage all",
	panelStageAllHint: "Stage all local changes",
	panelUnstageAllHint: "Unstage all changes",
	panelNothingStaged: "No staged changes to commit",

	diffTitle: "Diff",
	diffTitleFor: (path: string) => `Diff: ${path}`,
	diffLoading: "Loading diff…",
	diffError: (msg: string) => `Unable to show diff: ${msg}`,
	diffBinaryFile: "Binary file — diff not available",
	diffPluginNotReady: "Gitee Sync Plus is not loaded yet",
	diffLeftRemote: "Remote version",
	diffRightLocal: "Local version",
	diffLeftLocal: "Local version",
	diffRightRemote: "Remote version",
	diffLeftEmpty: "(empty)",
	diffRightEmpty: "(empty)",
	diffRevertChunk: "Revert this change block",
	diffRevertChunkConfirm: (path: string) =>
		`Revert this change block in "${path}"? The local file will be rewritten.`,
	diffReverted: "Change block reverted",
	diffRevertFailed: (msg: string) => `Revert failed: ${msg}`,
	statusTagModified: "M",
	cancel: "Cancel",
	statusTagAdded: "U",
	statusTagDeleted: "D",
	statusTagRemote: "↓",
};

const zh: typeof en = {
	clickToSync: "点击同步到远端仓库",
	ribbonSync: "同步到远端仓库",
	commandSyncNow: "立即同步",
	commandPreview: "预览同步计划（不执行，结果写入日志笔记）",
	statusIdle: "同步：空闲",
	statusRunning: "同步：进行中…",
	statusComplete: (time) => `同步：${time} 完成`,
	statusFailed: "同步：失败",
	syncInProgress: "同步正在进行中",
	syncFailed: (message) => `同步失败：${message}`,
	previewWhileSyncing: "同步正在进行中，请稍后再预览",
	previewComplete: (pulled, pushed, deletedLocal, deletedRemote, file) =>
		`预演完成：下载 ${pulled}，上传 ${pushed}，删除本地 ${deletedLocal}，` +
		`删除远端 ${deletedRemote}（详见 ${file}）`,
	previewFailed: (message) => `预演失败：${message}`,
	previewFailedLog: (time, message) => `\n## 同步预演失败 ${time}\n${message}\n`,
	diagnosticLogTitle: "# Gitee Sync Plus 诊断日志\n",
	summaryUpload: (count) => `上传 ${count}`,
	summaryDownload: (count) => `下载 ${count}`,
	summaryDeleteRemote: (count) => `删除远端 ${count}`,
	summaryDeleteLocal: (count) => `删除本地 ${count}`,
	summaryConflict: (count) => `冲突（按较新版本处理）${count}`,
	summaryComplete: (parts) => `同步完成：${parts}`,
	summaryNoChanges: "同步完成：无变化",

	missingGithubSettings: "请先在设置中填写 GitHub 用户名、仓库名和访问令牌。",
	missingGiteeSettings: "请先在设置中填写 Gitee 用户名、仓库名和私人令牌。",
	apiFailed: (host, method, status, detail) => `${host} API ${method} 失败（${status}）：${detail}`,
	remoteTreeTruncated: "远端返回的文件树被截断（文件数过多），已中止同步以防误删。",
	deleteNeedsSha: (path) => `删除 ${path} 需要远端 SHA。`,
	commitAdd: (path) => `同步：新增 ${path}`,
	commitUpdate: (path) => `同步：更新 ${path}`,
	commitDelete: (path) => `同步：删除 ${path}`,
	commitBatch: (uploaded, deleted) =>
		`同步：批量提交 — ${uploaded} 更新${deleted ? `，${deleted} 删除` : ""}`,
	batchCommitFailed: (uploaded, deleted, message) =>
		`批量提交失败（${uploaded} 个文件待更新，${deleted} 个待删除）：${message}`,

	settingsBackend: "存储后端",
	settingsBackendDesc: "切换后端后，首次同步会对两边差异做一次全量对账，并保留修改时间较新的版本。",
	optionGitee: "Gitee 仓库",
	optionGithub: "GitHub 仓库",
	settingsGiteeOwner: "Gitee 用户名",
	settingsGithubOwner: "GitHub 用户名",
	settingsOwnerDesc: "仓库所属的用户名或组织名（即仓库 URL 中的 owner）。",
	settingsRepo: "仓库名",
	settingsRepoDesc: "建议使用一个专门的私有仓库。",
	settingsBranch: "分支",
	settingsBranchNeedInfo: "填写用户名、仓库名和令牌后可自动获取分支列表。",
	settingsBranchLoadFailed: "无法获取分支列表，请检查用户名、仓库名和令牌是否正确。",
	refreshBranches: "刷新分支",
	settingsGiteeToken: "私人令牌",
	settingsGiteeTokenDesc: "Gitee 设置 → 安全设置 → 私人令牌，需勾选 projects 权限。",
	settingsGithubToken: "访问令牌",
	settingsGithubTokenDesc:
		"GitHub Settings → Developer settings → Personal access tokens；fine-grained 令牌需授予目标仓库 Contents 读写权限（classic 令牌勾选 repo）。",
	settingsAutoSync: "自动同步间隔（分钟）",
	settingsAutoSyncDesc: "0 表示关闭自动同步。",
	settingsSyncOnStart: "启动时同步",
	settingsSyncOnStartDesc: "Obsidian 打开后自动执行一次同步。",
	settingsExcludeFolders: "排除目录",
	settingsExcludeFoldersDesc:
		"vault 根目录 .gitignore 的完整内容。在这里编辑规则，下次同步时生效。输入框失去焦点时自动保存。",
	settingsDebugLog: "调试日志",
	settingsDebugLogDesc:
		"把每次同步的完整计划和结果记录到 vault 根目录的 _gitee-sync-plus-log.md（建议通过 .gitignore 排除同步）。",
	settingsCommitMode: "提交模式",
	settingsCommitModeDesc: "选择每个文件单独提交一次，还是将所有变更合并为一次提交。",
	optionPerFile: "每文件单独提交",
	optionBatch: "合并为一次提交（批量）",

	previewTitle: "同步预演（未执行）",
	executionTitle: "同步执行",
	pathFailed: (path, message) => `处理“${path}”失败：${message}`,
	resultFailed: (message) => `结果：**失败** — ${message}\n`,
	completedCounts: (pulled, pushed, deletedLocal, deletedRemote) =>
		`（已完成：下载 ${pulled}，上传 ${pushed}，删除本地 ${deletedLocal}，` +
		`删除远端 ${deletedRemote}）\n`,
	resultSuccess: (pulled, pushed, deletedLocal, deletedRemote, conflicts) =>
		`结果：成功 — 下载 ${pulled}，上传 ${pushed}，删除本地 ${deletedLocal}，` +
		`删除远端 ${deletedRemote}，冲突 ${conflicts}\n`,
	reasonLocalAdded: "本地新增",
	reasonLocalModified: "本地修改",
	reasonLocalDeleted: "本地已删除",
	reasonRemoteAdded: "远端新增",
	reasonRemoteModified: "远端修改",
	reasonRemoteDeleted: "远端已删除",
	reasonConflictLocalNewer: (local, remote) => `冲突：本地较新（本地 ${local} ≥ 远端 ${remote}）`,
	reasonConflictRemoteNewer: (remote, local) => `冲突：远端较新（远端 ${remote} > 本地 ${local}）`,
	reasonConflictKeepLocal: "冲突：远端已删但本地有修改，保留本地",
	reasonConflictKeepRemote: "冲突：本地已删但远端有修改，保留远端",
	planBackend: (target) => `后端：${target}`,
	planCounts: (local, remote, base, unchanged, conflicts) =>
		`本地 ${local} | 远端 ${remote} | **基线 ${base}** | 一致跳过 ${unchanged} | 冲突 ${conflicts}`,
	planNoActions: "计划：两端已一致，无需任何动作",
	planActions: (pulled, pushed, deletedLocal, deletedRemote) =>
		`计划：下载 ${pulled}，上传 ${pushed}，删除本地 ${deletedLocal}，删除远端 ${deletedRemote}`,
	actionDownload: "下载",
	actionDeleteLocal: "删除本地",
	actionUpload: "上传",
	actionDeleteRemote: "删除远端",
	unknown: "未知",

	panelTitle: "Git 面板",
	panelRibbon: "打开 Gitee Sync Plus Git 面板",
	panelOpenCommand: "打开 Git 面板",
	panelMessagePlaceholder: "提交说明（批量模式下生效）…",
	panelCommitHint: "每文件模式下每个文件保留各自说明；上方文本仅对批量提交生效。",
	panelCommit: "提交",
	panelPull: "拉取",
	panelRefresh: "刷新",
	panelGroupLocal: "本地更改",
	panelGroupRemote: "远端更改",
	panelGroupEmpty: "无",
	panelNoChanges: "无更改 —— 已完全同步",
	panelStatusComputing: "计算中…",
	panelStatusWorking: "处理中…",
	panelStatusChanges: (n) => `共 ${n} 处改动`,
	panelStatusError: (msg) => `错误：${msg}`,
	panelDiscard: "放弃",
	panelDiscardAll: "放弃全部",
	panelDiscardConfirmTitle: "放弃本地更改？",
	panelDiscardConfirm: (path) =>
		`放弃“${path}”的更改后，将用远端版本覆盖本地（若仅本地新增则删除本地文件），且不可恢复。`,
	panelDiscardAllConfirm: (n) =>
		`放弃全部 ${n} 处本地更改？本地修改将被远端版本覆盖，本地新增文件将被删除，且不可恢复。`,
	panelDiscarded: (n) => `已放弃 ${n} 处更改`,
	panelDiscardFailed: (msg) => `放弃失败：${msg}`,
	panelClickToDiff: "点击查看差异",
	panelGroupStaged: "暂存的更改",
	panelGroupUnstaged: "更改",
	panelStage: "暂存此文件",
	panelUnstage: "取消暂存此文件",
	panelStageAll: "全部暂存",
	panelUnstageAll: "全部取消暂存",
	panelStageAllHint: "暂存所有本地更改",
	panelUnstageAllHint: "取消暂存所有更改",
	panelNothingStaged: "没有已暂存的更改可提交",

	diffTitle: "差异对比",
	diffTitleFor: (path) => `差异：${path}`,
	diffLoading: "正在加载差异…",
	diffError: (msg) => `无法展示差异：${msg}`,
	diffBinaryFile: "二进制文件，暂不支持差异对比",
	diffPluginNotReady: "Gitee Sync Plus 尚未加载",
	diffLeftRemote: "远端版本",
	diffRightLocal: "本地版本",
	diffLeftLocal: "本地版本",
	diffRightRemote: "远端版本",
	diffLeftEmpty: "（空）",
	diffRightEmpty: "（空）",
	diffRevertChunk: "还原此更改块",
	diffRevertChunkConfirm: (path) =>
		`确定要还原“${path}”中的这一块更改吗？本地文件将被重写。`,
	diffReverted: "已还原更改块",
	diffRevertFailed: (msg) => `还原失败：${msg}`,
	statusTagModified: "M",
	cancel: "取消",
	statusTagAdded: "U",
	statusTagDeleted: "D",
	statusTagRemote: "↓",
};

export type Messages = typeof en;

export function messages(language = getLanguage()): Messages {
	return language.toLowerCase().startsWith("zh") ? zh : en;
}

export function formatDateTime(date = new Date()): string {
	return date.toLocaleString(getLanguage().toLowerCase().startsWith("zh") ? "zh-CN" : "en-US");
}

export function formatTime(date = new Date()): string {
	return date.toLocaleTimeString(getLanguage().toLowerCase().startsWith("zh") ? "zh-CN" : "en-US");
}
