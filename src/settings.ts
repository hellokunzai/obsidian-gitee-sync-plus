import { App, DropdownComponent, PluginSettingTab, Setting } from "obsidian";
import { messages } from "./i18n";
import type CloudSyncPlugin from "./main";
import { fetchBranches } from "./githost";

interface BranchCache {
	branches: string[];
	timestamp: number;
}

const branchCache = new Map<string, BranchCache>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCacheKey(host: string, owner: string, repo: string): string {
	return `${host}:${owner}/${repo}`;
}

function getCachedBranches(host: string, owner: string, repo: string): string[] | null {
	const key = getCacheKey(host, owner, repo);
	const cached = branchCache.get(key);
	if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
		return cached.branches;
	}
	return null;
}

function setCachedBranches(host: string, owner: string, repo: string, branches: string[]): void {
	const key = getCacheKey(host, owner, repo);
	branchCache.set(key, { branches, timestamp: Date.now() });
}

function clearBranchCache(host: string, owner: string, repo: string): void {
	const key = getCacheKey(host, owner, repo);
	branchCache.delete(key);
}

export type BackendType = "gitee" | "github";
export type CommitMode = "per-file" | "batch";

export interface SyncSettings {
	backend: BackendType;
	/* Gitee */
	giteeOwner: string;
	giteeRepo: string;
	giteeBranch: string;
	giteeToken: string;
	/* GitHub */
	githubOwner: string;
	githubRepo: string;
	githubBranch: string;
	githubToken: string;
	/* common */
	autoSyncMinutes: number;
	syncOnStart: boolean;
	/** @deprecated Migrated to the plugin-managed section of .gitignore. */
	excludeFolders?: string;
	debugLog: boolean;
	commitMode: CommitMode;
	showSyncRibbon: boolean;
	showPanelRibbon: boolean;
}

export const DEFAULT_SETTINGS: SyncSettings = {
	backend: "gitee",
	giteeOwner: "",
	giteeRepo: "",
	giteeBranch: "master",
	giteeToken: "",
	githubOwner: "",
	githubRepo: "",
	githubBranch: "main",
	githubToken: "",
	autoSyncMinutes: 0,
	syncOnStart: false,
	debugLog: false,
	commitMode: "per-file",
	showSyncRibbon: true,
	showPanelRibbon: true,
};

export class SyncSettingTab extends PluginSettingTab {
	private branchWidgets = new Map<
		"gitee" | "github",
		{ setting: Setting; dropdown: DropdownComponent; host: "gitee" | "github" }
	>();

	constructor(app: App, private plugin: CloudSyncPlugin) {
		super(app, plugin);
	}

	async display(): Promise<void> {
		const { containerEl } = this;
		containerEl.empty();
		// Wipe the branch-widget registry: the old dropdowns are detached and any
		// refreshBranchDropdown() call must only ever touch live elements.
		this.branchWidgets.clear();
		const l = messages();
		const s = this.plugin.settings;
		const save = () => this.plugin.savePluginData();
		const gitignoreContent = await this.plugin.gitIgnoreManager.readFullContent();

		// Opportunistic migration: when the user opens the settings panel we move
		// any plaintext token still sitting in data.json into the OS keychain.
		// The savePluginData inside the helper also redacts data.json.
		await this.plugin.migrateTokensToKeychain();
		const hasKeychain = !!this.app.secretStorage;

		// ── 仓库设置 ──────────────────────────────────────
		this.createSectionHeader(containerEl, l.sectionRepo);

		new Setting(containerEl)
			.setName(l.settingsBackend)
			.setDesc(l.settingsBackendDesc)
			.addDropdown((d) =>
				d
					.addOption("gitee", l.optionGitee)
					.addOption("github", l.optionGithub)
					.setValue(s.backend)
					.onChange(async (v) => {
						s.backend = v as BackendType;
						await save();
						this.display();
					})
			);

		if (s.backend === "gitee") {
			new Setting(containerEl)
				.setName(l.settingsGiteeToken)
				.setDesc(
					hasKeychain
						? `${l.settingsGiteeTokenDesc} ${l.tokenStoredInKeychain}`
						: l.settingsGiteeTokenDesc
				)
.addText((t) => {
				t.inputEl.type = "password";
				// Typing updates the in-memory value only; the keychain mirror (and
				// the redacted data.json copy) is written once when the field loses
				// focus, not on every keystroke.
				t.setValue(s.giteeToken).onChange(async (v) => {
					s.giteeToken = v.trim();
				});
				t.inputEl.addEventListener("blur", () => {
					void save();
				});
			});

			new Setting(containerEl)
				.setName(l.settingsGiteeOwner)
				.setDesc(l.settingsOwnerDesc)
				.addText((t) =>
					t.setPlaceholder("your-name").setValue(s.giteeOwner).onChange(async (v) => {
						s.giteeOwner = v.trim();
						await save();
						void this.refreshBranchDropdown("gitee");
					})
				);

			new Setting(containerEl)
				.setName(l.settingsRepo)
				.setDesc(l.settingsRepoDesc)
				.addText((t) =>
					t.setPlaceholder("obsidian-vault").setValue(s.giteeRepo).onChange(async (v) => {
						s.giteeRepo = v.trim();
						await save();
						void this.refreshBranchDropdown("gitee");
					})
				);

			await this.renderBranchSetting(
				containerEl,
				"gitee",
				s.giteeOwner,
				s.giteeRepo,
				s.giteeToken,
				s.giteeBranch,
				(v) => {
					s.giteeBranch = v;
				}
			);
		} else {
			new Setting(containerEl)
				.setName(l.settingsGithubToken)
				.setDesc(
					hasKeychain
						? `${l.settingsGithubTokenDesc} ${l.tokenStoredInKeychain}`
						: l.settingsGithubTokenDesc
				)
.addText((t) => {
				t.inputEl.type = "password";
				// Typing updates the in-memory value only; the keychain mirror (and
				// the redacted data.json copy) is written once when the field loses
				// focus, not on every keystroke.
				t.setValue(s.githubToken).onChange(async (v) => {
					s.githubToken = v.trim();
				});
				t.inputEl.addEventListener("blur", () => {
					void save();
				});
			});

			new Setting(containerEl)
				.setName(l.settingsGithubOwner)
				.setDesc(l.settingsOwnerDesc)
				.addText((t) =>
					t.setPlaceholder("your-name").setValue(s.githubOwner).onChange(async (v) => {
						s.githubOwner = v.trim();
						await save();
						void this.refreshBranchDropdown("github");
					})
				);

			new Setting(containerEl)
				.setName(l.settingsRepo)
				.setDesc(l.settingsRepoDesc)
				.addText((t) =>
					t.setPlaceholder("obsidian-vault").setValue(s.githubRepo).onChange(async (v) => {
						s.githubRepo = v.trim();
						await save();
						void this.refreshBranchDropdown("github");
					})
				);

			await this.renderBranchSetting(
				containerEl,
				"github",
				s.githubOwner,
				s.githubRepo,
				s.githubToken,
				s.githubBranch,
				(v) => {
					s.githubBranch = v;
				}
			);
		}

		new Setting(containerEl)
			.setName(l.settingsShowSyncRibbon)
			.setDesc(l.settingsShowSyncRibbonDesc)
			.addToggle((t) =>
				t.setValue(s.showSyncRibbon).onChange(async (v) => {
					s.showSyncRibbon = v;
					await save();
					this.plugin.updateRibbonIcons();
				})
			);

		// ── 自动同步 ──────────────────────────────────────
		this.createSectionHeader(containerEl, l.sectionAutoSync);

		new Setting(containerEl)
			.setName(l.settingsSyncOnStart)
			.setDesc(l.settingsSyncOnStartDesc)
			.addToggle((t) =>
				t.setValue(s.syncOnStart).onChange(async (v) => {
					s.syncOnStart = v;
					await save();
				})
			);

		new Setting(containerEl)
			.setName(l.settingsCommitMode)
			.setDesc(l.settingsCommitModeDesc)
			.addDropdown((d) =>
				d
					.addOption("per-file", l.optionPerFile)
					.addOption("batch", l.optionBatch)
					.setValue(s.commitMode)
					.onChange(async (v) => {
						s.commitMode = v as CommitMode;
						await save();
					})
			);

		new Setting(containerEl)
			.setName(l.settingsAutoSync)
			.setDesc(l.settingsAutoSyncDesc)
			.addText((t) =>
				t.setValue(String(s.autoSyncMinutes)).onChange(async (v) => {
					const n = Number(v);
					s.autoSyncMinutes = Number.isFinite(n) && n > 0 ? n : 0;
					await save();
					this.plugin.setupAutoSync();
				})
			);

		// ── 高级设置 ──────────────────────────────────────
		this.createSectionHeader(containerEl, l.sectionAdvanced);

		new Setting(containerEl)
			.setName(l.settingsShowPanelRibbon)
			.setDesc(l.settingsShowPanelRibbonDesc)
			.addToggle((t) =>
				t.setValue(s.showPanelRibbon).onChange(async (v) => {
					s.showPanelRibbon = v;
					await save();
					this.plugin.updateRibbonIcons();
				})
			);

		new Setting(containerEl)
			.setName(l.settingsDebugLog)
			.setDesc(l.settingsDebugLogDesc)
			.addToggle((t) =>
				t.setValue(s.debugLog).onChange(async (v) => {
					s.debugLog = v;
					await save();
				})
			);

		new Setting(containerEl)
			.setName(l.settingsExcludeFolders)
			.setDesc(l.settingsExcludeFoldersDesc)
			.addTextArea((t) => {
				t.setValue(gitignoreContent);
				t.inputEl.rows = 12;
				t.inputEl.addClass('gitee-sync-plus-gitignore-editor');
				t.inputEl.addEventListener("blur", async () => {
					await this.plugin.gitIgnoreManager.writeFullContent(t.getValue());
				});
			});
	}

	private createSectionHeader(containerEl: HTMLElement, title: string): void {
		const header = containerEl.createDiv({ cls: "setting-item" });
		header.addClass("gitee-sync-plus-section-header");
		const nameEl = header.createDiv({ cls: "setting-item-name" });
		nameEl.setText(title);
		const descEl = header.createDiv({ cls: "setting-item-description" });
	}

	private async renderBranchSetting(
		containerEl: HTMLElement,
		host: "gitee" | "github",
		owner: string,
		repo: string,
		token: string,
		currentBranch: string,
		setBranch: (v: string) => void
	): Promise<void> {
		const l = messages();
		const save = () => this.plugin.savePluginData();
		const setting = new Setting(containerEl).setName(l.settingsBranch);
		const defaultBranch = host === "github" ? "main" : "master";
		const value = currentBranch || defaultBranch;

		// 先渲染下拉框（可能为空或只有当前值）
		let dropdownComponent!: DropdownComponent;
		let isLoading = false;

		setting.addDropdown((d) => {
			dropdownComponent = d;
			d.addOption(value, value);
			d.setValue(value);
			d.onChange(async (v) => {
				setBranch(v);
				await save();
			});
		});

		// Register the widget so refreshBranchDropdown() can update it in place
		// when owner/repo changes, without re-rendering the whole settings panel.
		this.branchWidgets.set(host, { setting, dropdown: dropdownComponent, host });

		setting.addButton((b) =>
			b
				.setIcon("refresh-cw")
				.setTooltip(l.refreshBranches)
				.onClick(async () => {
					if (isLoading || !owner || !repo || !token) return;
					isLoading = true;
					b.setDisabled(true);
					try {
						clearBranchCache(host, owner, repo);
						const branches = await fetchBranches(host, owner, repo, token);
						setCachedBranches(host, owner, repo, branches);
						// 先记录当前选择，再清空并重新填充选项
						const currentVal = dropdownComponent.getValue() as string;
						dropdownComponent.selectEl.empty();
						for (const branch of branches) {
							dropdownComponent.addOption(branch, branch);
						}
						if (branches.includes(currentVal)) {
							dropdownComponent.setValue(currentVal);
						} else if (branches.length > 0) {
							dropdownComponent.setValue(branches[0]);
							setBranch(branches[0]);
							await save();
						}
						setting.setDesc("");
					} catch (err: any) {
						setting.setDesc(l.settingsBranchLoadFailed);
					} finally {
						isLoading = false;
						b.setDisabled(false);
					}
				})
		);

		// 如果信息齐全，尝试从缓存加载或静默预加载
		if (owner && repo && token) {
			const cached = getCachedBranches(host, owner, repo);
			if (cached) {
				// 先记录当前选择，再重新填充缓存分支
				const currentVal = dropdownComponent.getValue() as string;
				dropdownComponent.selectEl.innerHTML = "";
				for (const branch of cached) {
					dropdownComponent.addOption(branch, branch);
				}
				if (cached.includes(currentVal)) {
					dropdownComponent.setValue(currentVal);
				} else if (cached.length > 0) {
					dropdownComponent.setValue(cached[0]);
					setBranch(cached[0]);
					await save();
				}
			}
			// 无缓存时不自动加载，等用户点击刷新按钮
		} else {
			setting.setDesc(l.settingsBranchNeedInfo);
		}
	}

	/**
	 * Re-fetches branches for the given host using the CURRENT settings
	 * (owner/repo/token) and refreshes the dropdown options in place. Called
	 * from the owner/repo onChange handlers instead of the full this.display()
	 * re-render so the user does not lose focus on every keystroke.
	 */
	private async refreshBranchDropdown(host: "gitee" | "github"): Promise<void> {
		const widget = this.branchWidgets.get(host);
		if (!widget) return;
		const s = this.plugin.settings;
		const owner = host === "gitee" ? s.giteeOwner : s.githubOwner;
		const repo = host === "gitee" ? s.giteeRepo : s.githubRepo;
		const token = host === "gitee" ? s.giteeToken : s.githubToken;
		if (!owner || !repo || !token) return;

		try {
			clearBranchCache(host, owner, repo);
			const branches = await fetchBranches(host, owner, repo, token);
			setCachedBranches(host, owner, repo, branches);
			const currentVal = widget.dropdown.getValue() as string;
			widget.dropdown.selectEl.empty();
			for (const branch of branches) {
				widget.dropdown.addOption(branch, branch);
			}
			if (branches.includes(currentVal)) {
				widget.dropdown.setValue(currentVal);
			} else if (branches.length > 0) {
				widget.dropdown.setValue(branches[0]);
				if (host === "gitee") s.giteeBranch = branches[0];
				else s.githubBranch = branches[0];
				await this.plugin.savePluginData();
			}
			widget.setting.setDesc("");
		} catch {
			widget.setting.setDesc(messages().settingsBranchLoadFailed);
		}
	}
}
