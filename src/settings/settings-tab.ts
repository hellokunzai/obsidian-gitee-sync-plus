import { App, DropdownComponent, Modal, Notice, PluginSettingTab, setIcon, Setting } from "obsidian";
import { messages, type Messages } from "../utils/i18n";
import type CloudSyncPlugin from "../main";
import { fetchGiteeBranches, testGiteeToken } from "../backends/gitee";
import { fetchGithubBranches, testGithubToken } from "../backends/github";
import { DEFAULT_GITLAB_URL, fetchGitLabBranches, testGitLabToken } from "../backends/gitlab";
import { TokenManager, type TokenHost } from "../utils/token-manager";
import type { BackendType, SyncSettings } from "../types/settings";
import { TokenSelectModal } from "./token-select-modal";

interface BranchCache {
	branches: string[];
	timestamp: number;
}

type Host = "gitee" | "github" | "gitlab";

interface HostCfg {
	ownerKey: "giteeOwner" | "githubOwner" | "gitlabOwner";
	repoKey: "giteeRepo" | "githubRepo" | "gitlabRepo";
	branchKey: "giteeBranch" | "githubBranch" | "gitlabBranch";
	tokenKey: "giteeToken" | "githubToken" | "gitlabToken";
	profileKey: "giteeTokenProfile" | "githubTokenProfile" | "gitlabTokenProfile";
	ownerLabel: keyof Messages;
	defaultBranch: string;
	missingSettings: keyof Messages;
	testToken: (owner: string, repo: string, token: string, gitlabUrl?: string) => Promise<void>;
	fetchBranches: (owner: string, repo: string, token: string, gitlabUrl?: string) => Promise<string[]>;
}

function hostCfg(host: Host): HostCfg {
	switch (host) {
		case "gitee":
			return {
				ownerKey: "giteeOwner",
				repoKey: "giteeRepo",
				branchKey: "giteeBranch",
				tokenKey: "giteeToken",
				profileKey: "giteeTokenProfile",
				ownerLabel: "settingsGiteeOwner",
				defaultBranch: "master",
				missingSettings: "missingGiteeSettings",
				testToken: testGiteeToken,
				fetchBranches: fetchGiteeBranches,
			};
		case "github":
			return {
				ownerKey: "githubOwner",
				repoKey: "githubRepo",
				branchKey: "githubBranch",
				tokenKey: "githubToken",
				profileKey: "githubTokenProfile",
				ownerLabel: "settingsGithubOwner",
				defaultBranch: "main",
				missingSettings: "missingGithubSettings",
				testToken: testGithubToken,
				fetchBranches: fetchGithubBranches,
			};
		case "gitlab":
			return {
				ownerKey: "gitlabOwner",
				repoKey: "gitlabRepo",
				branchKey: "gitlabBranch",
				tokenKey: "gitlabToken",
				profileKey: "gitlabTokenProfile",
				ownerLabel: "settingsGitlabOwner",
				defaultBranch: "main",
				missingSettings: "missingGitlabSettings",
				testToken: testGitLabToken,
				fetchBranches: fetchGitLabBranches,
			};
	}
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

export const DEFAULT_SETTINGS: SyncSettings = {
	backend: "gitee",
	giteeOwner: "",
	giteeRepo: "",
	giteeBranch: "master",
	giteeToken: "",
	giteeTokenProfile: "",
	githubOwner: "",
	githubRepo: "",
	githubBranch: "main",
	githubToken: "",
	githubTokenProfile: "",
	gitlabOwner: "",
	gitlabRepo: "",
	gitlabBranch: "main",
	gitlabToken: "",
	gitlabTokenProfile: "",
	gitlabUrl: DEFAULT_GITLAB_URL,
	autoSyncMinutes: 0,
	syncOnStart: false,
	debugLog: false,
	commitMode: "per-file",
	mergeStrategy: "mtime",
	showSyncRibbon: true,
	showPanelRibbon: false,
};

export class SyncSettingTab extends PluginSettingTab {
	private branchWidgets = new Map<
		Host,
		{ setting: Setting; dropdown: DropdownComponent; host: Host }
	>();
	private tokenManager: TokenManager;

	constructor(app: App, private plugin: CloudSyncPlugin) {
		super(app, plugin);
		this.tokenManager = plugin.tokenManager;
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
					.addOption("gitlab", l.optionGitlab)
					.setValue(s.backend)
					.onChange(async (v) => {
						s.backend = v as BackendType;
						await save();
						this.display();
					})
			);

		if (s.backend === "gitee") {
			this.renderRepoSection("gitee", l.settingsGiteeToken, l.settingsGiteeTokenDesc);
		} else if (s.backend === "github") {
			this.renderRepoSection("github", l.settingsGithubToken, l.settingsGithubTokenDesc);
		} else {
			this.renderRepoSection("gitlab", l.settingsGitlabToken, l.settingsGitlabTokenDesc);
			new Setting(containerEl)
				.setName(l.settingsGitlabUrl)
				.setDesc(l.settingsGitlabUrlDesc)
				.addText((t) =>
					t
						.setPlaceholder(DEFAULT_GITLAB_URL)
						.setValue(s.gitlabUrl)
						.onChange(async (v) => {
							s.gitlabUrl = v.trim() || DEFAULT_GITLAB_URL;
							await save();
							void this.refreshBranchDropdown("gitlab");
						})
				);
		}

		// ── 同步设置 ──────────────────────────────────────
		this.createSectionHeader(containerEl, l.sectionAutoSync);

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
			.setName(l.settingsAutoSync)
			.setDesc(l.settingsAutoSyncDesc)
			.addText((t) => {
				t.setValue(String(s.autoSyncMinutes)).onChange(async (v) => {
					const n = Number(v);
					s.autoSyncMinutes = Number.isFinite(n) && n > 0 ? n : 0;
					await save();
					this.plugin.setupAutoSync();
				});
				// Restrict input to non-negative integers (minutes).
				t.inputEl.type = "number";
				t.inputEl.min = "0";
				t.inputEl.step = "1";
				t.inputEl.inputMode = "numeric";
			});

		new Setting(containerEl)
			.setName(l.settingsMergeStrategy)
			.setDesc(l.settingsMergeStrategyDesc)
			.addDropdown((d) =>
				d
					.addOption("mtime", l.optionMergeMtime)
					.addOption("remote", l.optionMergeRemote)
					.addOption("local", l.optionMergeLocal)
					.setValue(s.mergeStrategy)
					.onChange(async (v) => {
						s.mergeStrategy = v as SyncSettings["mergeStrategy"];
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
						s.commitMode = v as SyncSettings["commitMode"];
						await save();
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
			})
			.settingEl.addClass('gitee-sync-plus-gitignore-setting');
	}

	private renderRepoSection(host: Host, tokenName: string, tokenDesc: string): void {
		const l = messages();
		const cfg = hostCfg(host);
		const s = this.plugin.settings;
		const save = () => this.plugin.savePluginData();

		this.renderTokenSetting(host, tokenName, tokenDesc);

		new Setting(this.containerEl)
			.setName(l[cfg.ownerLabel] as string)
			.setDesc(l.settingsOwnerDesc)
			.addText((t) =>
				t.setPlaceholder("your-name").setValue(s[cfg.ownerKey]).onChange(async (v) => {
					s[cfg.ownerKey] = v.trim();
					await save();
					void this.refreshBranchDropdown(host);
				})
			);

		new Setting(this.containerEl)
			.setName(l.settingsRepo)
			.setDesc(l.settingsRepoDesc)
			.addText((t) =>
				t.setPlaceholder("obsidian-vault").setValue(s[cfg.repoKey]).onChange(async (v) => {
					s[cfg.repoKey] = v.trim();
					await save();
					void this.refreshBranchDropdown(host);
				})
			);

		void this.renderBranchSetting(host, (v) => {
			s[cfg.branchKey] = v;
		});
	}

	private renderTokenSetting(host: Host, name: string, desc: string): void {
		const l = messages();
		const cfg = hostCfg(host);
		const setting = new Setting(this.containerEl).setName(name).setDesc(desc);
		const activeKey = this.tokenManager.getActiveKey(host);

		setting.addButton((b) =>
			b
				.setButtonText(l.selectToken)
				.setTooltip(activeKey || l.selectToken)
				.onClick(() => {
					new TokenSelectModal(this.app, this.plugin, host, () => this.display()).open();
				})
		);

		setting.addButton((b) =>
			b
				.setButtonText(l.testToken)
				.setCta()
				.onClick(async () => {
					const key = this.tokenManager.getActiveKey(host);
					if (!key) {
						new Notice(l.tokenNoTokenSelected);
						return;
					}
					const token = await this.tokenManager.getToken(key);
					if (!token) {
						new Notice(l.tokenNoTokenSelected);
						return;
					}
					const s = this.plugin.settings;
					const owner = s[cfg.ownerKey];
					const repo = s[cfg.repoKey];
					const gitlabUrl = host === "gitlab" ? s.gitlabUrl : undefined;
					if (!owner || !repo) {
						new Notice(l[cfg.missingSettings] as string);
						return;
					}
					b.setDisabled(true);
					try {
						await cfg.testToken(owner, repo, token, gitlabUrl);
						new Notice(l.tokenTestSuccess);
					} catch (e: any) {
						const msg = e instanceof Error ? e.message : String(e);
						new Notice(l.tokenTestFailed(msg), 8000);
					} finally {
						b.setDisabled(false);
					}
				})
		);
	}

	private createSectionHeader(containerEl: HTMLElement, title: string): void {
		const header = containerEl.createDiv({ cls: "setting-item" });
		header.addClass("gitee-sync-plus-section-header");
		const nameEl = header.createDiv({ cls: "setting-item-name" });
		nameEl.setText(title);
		const descEl = header.createDiv({ cls: "setting-item-description" });
	}

	private async renderBranchSetting(host: Host, setBranch: (v: string) => void): Promise<void> {
		const l = messages();
		const cfg = hostCfg(host);
		const s = this.plugin.settings;
		const save = () => this.plugin.savePluginData();
		const owner = s[cfg.ownerKey];
		const repo = s[cfg.repoKey];
		const token = s[cfg.tokenKey];
		const currentBranch = s[cfg.branchKey];
		const defaultBranch = cfg.defaultBranch;
		const value = currentBranch || defaultBranch;

		// 先渲染下拉框（可能为空或只有当前值）
		let dropdownComponent!: DropdownComponent;
		let isLoading = false;

		const setting = new Setting(this.containerEl).setName(l.settingsBranch);

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
						const gitlabUrl = host === "gitlab" ? s.gitlabUrl : undefined;
						const branches = await cfg.fetchBranches(owner, repo, token, gitlabUrl);
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
	private async refreshBranchDropdown(host: Host): Promise<void> {
		const widget = this.branchWidgets.get(host);
		if (!widget) return;
		const cfg = hostCfg(host);
		const s = this.plugin.settings;
		const owner = s[cfg.ownerKey];
		const repo = s[cfg.repoKey];
		const token = s[cfg.tokenKey];
		if (!owner || !repo || !token) return;

		try {
			const gitlabUrl = host === "gitlab" ? s.gitlabUrl : undefined;
			clearBranchCache(host, owner, repo);
			const branches = await cfg.fetchBranches(owner, repo, token, gitlabUrl);
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
				s[cfg.branchKey] = branches[0];
				await this.plugin.savePluginData();
			}
			widget.setting.setDesc("");
		} catch {
			widget.setting.setDesc(messages().settingsBranchLoadFailed);
		}
	}
}
