import { App, PluginSettingTab, Setting } from "obsidian";
import { messages } from "./i18n";
import type CloudSyncPlugin from "./main";
import { fetchBranches } from "./githost";

export type BackendType = "gitee" | "github";

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
};

export class SyncSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: CloudSyncPlugin) {
		super(app, plugin);
	}

	async display(): Promise<void> {
		const { containerEl } = this;
		containerEl.empty();
		const l = messages();
		const s = this.plugin.settings;
		const save = () => this.plugin.savePluginData();
		const gitignoreContent = await this.plugin.gitIgnoreManager.readFullContent();

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
				.setDesc(l.settingsGiteeTokenDesc)
				.addText((t) => {
					t.inputEl.type = "password";
					t.setValue(s.giteeToken).onChange(async (v) => {
						s.giteeToken = v.trim();
						await save();
						this.display();
					});
				});

			new Setting(containerEl)
				.setName(l.settingsGiteeOwner)
				.setDesc(l.settingsOwnerDesc)
				.addText((t) =>
					t.setPlaceholder("your-name").setValue(s.giteeOwner).onChange(async (v) => {
						s.giteeOwner = v.trim();
						await save();
						this.display();
					})
				);

			new Setting(containerEl)
				.setName(l.settingsRepo)
				.setDesc(l.settingsRepoDesc)
				.addText((t) =>
					t.setPlaceholder("obsidian-vault").setValue(s.giteeRepo).onChange(async (v) => {
						s.giteeRepo = v.trim();
						await save();
						this.display();
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
				.setDesc(l.settingsGithubTokenDesc)
				.addText((t) => {
					t.inputEl.type = "password";
					t.setValue(s.githubToken).onChange(async (v) => {
						s.githubToken = v.trim();
						await save();
						this.display();
					});
				});

			new Setting(containerEl)
				.setName(l.settingsGithubOwner)
				.setDesc(l.settingsOwnerDesc)
				.addText((t) =>
					t.setPlaceholder("your-name").setValue(s.githubOwner).onChange(async (v) => {
						s.githubOwner = v.trim();
						await save();
						this.display();
					})
				);

			new Setting(containerEl)
				.setName(l.settingsRepo)
				.setDesc(l.settingsRepoDesc)
				.addText((t) =>
					t.setPlaceholder("obsidian-vault").setValue(s.githubRepo).onChange(async (v) => {
						s.githubRepo = v.trim();
						await save();
						this.display();
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
			.setName(l.settingsExcludeFolders)
			.setDesc(l.settingsExcludeFoldersDesc)
			.addTextArea((t) => {
				t.setValue(gitignoreContent);
				t.inputEl.rows = 12;
				t.inputEl.style.width = "100%";
				t.inputEl.style.fontFamily = "monospace";
				t.inputEl.addEventListener("blur", async () => {
					await this.plugin.gitIgnoreManager.writeFullContent(t.getValue());
				});
			});

		new Setting(containerEl)
			.setName(l.settingsDebugLog)
			.setDesc(l.settingsDebugLogDesc)
			.addToggle((t) =>
				t.setValue(s.debugLog).onChange(async (v) => {
					s.debugLog = v;
					await save();
				})
			);
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

		const renderDisabled = (desc?: string) => {
			setting.addDropdown((d) => {
				d.addOption(value, value);
				d.setValue(value);
				d.selectEl.disabled = true;
				d.onChange(async (v) => {
					setBranch(v);
					await save();
				});
			});
			setting.addButton((b) =>
				b
					.setIcon("refresh-cw")
					.setTooltip(l.refreshBranches)
					.onClick(() => this.display())
			);
			if (desc) setting.setDesc(desc);
		};

		if (owner && repo && token) {
			try {
				const branches = await fetchBranches(host, owner, repo, token);
				if (branches.length === 0) {
					throw new Error("No branches");
				}
				setting.addDropdown((d) => {
					for (const b of branches) {
						d.addOption(b, b);
					}
					d.setValue(value);
					d.onChange(async (v) => {
						setBranch(v);
						await save();
					});
				});
				setting.addButton((b) =>
					b
						.setIcon("refresh-cw")
						.setTooltip(l.refreshBranches)
						.onClick(() => this.display())
				);
				return;
			} catch {
				renderDisabled(l.settingsBranchLoadFailed);
				return;
			}
		}

		renderDisabled(l.settingsBranchNeedInfo);
	}
}
