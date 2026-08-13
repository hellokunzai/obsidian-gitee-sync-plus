import { App, DropdownComponent, Modal, Notice, PluginSettingTab, setIcon, Setting } from "obsidian";
import { messages } from "./i18n";
import type CloudSyncPlugin from "./main";
import { fetchBranches, testToken } from "./githost";
import { TokenManager } from "./token-manager";

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
	giteeTokenProfile: string;
	/* GitHub */
	githubOwner: string;
	githubRepo: string;
	githubBranch: string;
	githubToken: string;
	githubTokenProfile: string;
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
	giteeTokenProfile: "",
	githubOwner: "",
	githubRepo: "",
	githubBranch: "main",
	githubToken: "",
	githubTokenProfile: "",
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
					.setValue(s.backend)
					.onChange(async (v) => {
						s.backend = v as BackendType;
						await save();
						this.display();
					})
			);

		if (s.backend === "gitee") {
			this.renderTokenSetting(containerEl, "gitee", l.settingsGiteeToken, l.settingsGiteeTokenDesc);

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
			this.renderTokenSetting(containerEl, "github", l.settingsGithubToken, l.settingsGithubTokenDesc);

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

	private renderTokenSetting(
		containerEl: HTMLElement,
		host: "gitee" | "github",
		name: string,
		desc: string
	): void {
		const l = messages();
		const setting = new Setting(containerEl).setName(name).setDesc(desc);
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
					const owner = host === "gitee" ? this.plugin.settings.giteeOwner : this.plugin.settings.githubOwner;
					const repo = host === "gitee" ? this.plugin.settings.giteeRepo : this.plugin.settings.githubRepo;
					if (!owner || !repo) {
						new Notice(host === "gitee" ? l.missingGiteeSettings : l.missingGithubSettings);
						return;
					}
					b.setDisabled(true);
					try {
						await testToken(host, owner, repo, token);
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

class TokenSelectModal extends Modal {
	private selectedName: string | null;
	private searchQuery = "";
	private showAddForm = false;
	private visibleTokens = new Set<string>();
	private secrets: string[] = [];
	private listContainer!: HTMLElement;
	private addForm!: HTMLElement;
	private nameInput!: HTMLInputElement;
	private valueInput!: HTMLInputElement;

	constructor(
		app: App,
		private plugin: CloudSyncPlugin,
		private host: "gitee" | "github",
		private onSave: () => void
	) {
		super(app);
		this.selectedName = this.plugin.tokenManager.getActiveKey(host);
	}

	onOpen(): void {
		this.modalEl.addClass("gitee-sync-plus-token-modal");

		const { contentEl } = this;
		contentEl.empty();
		const l = messages();

		contentEl.createEl("h2", { text: l.tokenSelectTitle, cls: "gitee-sync-plus-token-title" });

		// Search box
		const searchContainer = contentEl.createDiv({ cls: "gitee-sync-plus-token-search" });
		const searchInput = searchContainer.createEl("input", {
			type: "search",
			placeholder: l.tokenSearchPlaceholder,
			cls: "gitee-sync-plus-token-search-input",
		});
		searchInput.value = this.searchQuery;
		searchInput.addEventListener("input", () => {
			this.searchQuery = searchInput.value.trim().toLowerCase();
			this.renderList();
		});

		// Add form (hidden by default)
		this.addForm = contentEl.createDiv({ cls: "gitee-sync-plus-token-add-form" });
		this.addForm.style.display = this.showAddForm ? "block" : "none";

		this.nameInput = this.addForm.createEl("input", {
			type: "text",
			placeholder: l.tokenKeyId,
			cls: "gitee-sync-plus-token-add-input",
		});
		this.valueInput = this.addForm.createEl("input", {
			type: "password",
			placeholder: l.tokenValue,
			cls: "gitee-sync-plus-token-add-input",
		});

		const addFormButtons = this.addForm.createDiv({ cls: "gitee-sync-plus-token-add-buttons" });
		const confirmAddBtn = addFormButtons.createEl("button", { text: l.tokenConfirmAdd, cls: "mod-cta" });
		const cancelAddBtn = addFormButtons.createEl("button", { text: l.tokenCancel });

		confirmAddBtn.addEventListener("click", () => {
			void this.addSecret();
		});
		cancelAddBtn.addEventListener("click", () => {
			this.toggleAddForm(false);
		});

		// List container
		this.listContainer = contentEl.createDiv({ cls: "gitee-sync-plus-token-list" });

		// Footer buttons
		const footer = contentEl.createDiv({ cls: "gitee-sync-plus-token-footer" });
		const addBtn = footer.createEl("button", { text: l.tokenAdd });
		addBtn.addEventListener("click", () => {
			this.toggleAddForm(true);
			this.nameInput.focus();
		});

		const rightButtons = footer.createDiv({ cls: "gitee-sync-plus-token-footer-right" });
		const saveBtn = rightButtons.createEl("button", { text: l.tokenSave, cls: "mod-cta" });
		const cancelBtn = rightButtons.createEl("button", { text: l.tokenCancel });

		saveBtn.addEventListener("click", () => {
			void this.save();
		});
		cancelBtn.addEventListener("click", () => {
			this.close();
		});

		this.scope.register([], "Escape", () => this.close());

		// Load the actual keychain entries and then render.
		this.renderList();
		void this.loadSecrets();
	}

	private async loadSecrets(): Promise<void> {
		this.secrets = await this.plugin.tokenManager.listSecrets();
		this.renderList();
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}

	private toggleAddForm(show: boolean): void {
		this.showAddForm = show;
		this.addForm.style.display = show ? "block" : "none";
		if (!show) {
			this.nameInput.value = "";
			this.valueInput.value = "";
		}
	}

	private renderList(): void {
		const l = messages();
		this.listContainer.empty();
		const keys = this.secrets.filter((k) => k.toLowerCase().includes(this.searchQuery));

		if (keys.length === 0) {
			this.listContainer.createDiv({
				text: this.searchQuery ? l.tokenNoMatch : l.tokenEmpty,
				cls: "gitee-sync-plus-token-empty",
			});
			return;
		}

		for (const key of keys) {
			const isSelected = this.selectedName === key;
			const item = this.listContainer.createDiv({ cls: "gitee-sync-plus-token-item" });
			if (isSelected) item.addClass("is-selected");

			const left = item.createDiv({ cls: "gitee-sync-plus-token-item-left" });
			const radio = left.createEl("input", { type: "radio", value: key });
			radio.name = "token-select";
			radio.checked = isSelected;
			radio.addEventListener("change", () => {
				this.selectedName = key;
				this.renderList();
			});

			left.createSpan({ text: key, cls: "gitee-sync-plus-token-name" });

			if (isSelected) {
				left.createSpan({ text: l.tokenSelected, cls: "gitee-sync-plus-token-badge" });
			}

			const actions = item.createDiv({ cls: "gitee-sync-plus-token-actions" });

			// Eye toggle
			const isVisible = this.visibleTokens.has(key);
			const eyeBtn = actions.createEl("button", { cls: "gitee-sync-plus-token-icon-btn" });
			setIcon(eyeBtn, isVisible ? "eye-off" : "eye");
			eyeBtn.addEventListener("click", () => {
				if (isVisible) {
					this.visibleTokens.delete(key);
				} else {
					this.visibleTokens.add(key);
				}
				this.renderList();
			});

			// Delete button
			const delBtn = actions.createEl("button", { cls: "gitee-sync-plus-token-icon-btn" });
			setIcon(delBtn, "trash-2");
			delBtn.addEventListener("click", () => {
				if (confirm(l.tokenDeleteConfirm(key))) {
					void this.deleteSecret(key);
				}
			});

			// Show token value inline when visible
			if (isVisible) {
				void this.plugin.tokenManager.getToken(key).then((v) => {
					const valueEl = item.createDiv({ cls: "gitee-sync-plus-token-value" });
					valueEl.setText(v ?? "");
				});
			}
		}
	}

	private async addSecret(): Promise<void> {
		const l = messages();
		const rawName = this.nameInput.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
		const value = this.valueInput.value.trim();
		if (!rawName) {
			new Notice(l.tokenNameRequired);
			return;
		}
		if (!value) {
			new Notice(l.tokenValueRequired);
			return;
		}
		if (this.secrets.includes(rawName)) {
			new Notice(l.tokenDuplicateName);
			return;
		}
		try {
			await this.plugin.tokenManager.setToken(rawName, value);
			this.secrets.push(rawName);
			this.selectedName = rawName;
			this.toggleAddForm(false);
			this.renderList();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(l.tokenSaveFailed(msg), 8000);
		}
	}

	private async deleteSecret(name: string): Promise<void> {
		await this.plugin.tokenManager.deleteToken(name);
		this.secrets = this.secrets.filter((k) => k !== name);
		if (this.selectedName === name) {
			this.selectedName = null;
		}
		this.renderList();
	}

	private async save(): Promise<void> {
		await this.plugin.tokenManager.setActiveKey(this.host, this.selectedName);
		this.onSave();
		this.close();
	}
}
