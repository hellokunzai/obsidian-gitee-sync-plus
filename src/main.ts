import { Notice, Platform, Plugin } from "obsidian";
import { GitIgnoreManager } from "./gitignore";
import { formatDateTime, formatTime, messages } from "./i18n";
import { DEFAULT_SETTINGS, SyncSettings, SyncSettingTab } from "./settings";
import { GIT_PANEL_VIEW_TYPE, GitPanelView } from "./GitPanelView";
import { DIFF_VIEW_TYPE, DiffView, setDiffPluginInstance } from "./DiffView";
import { LOG_FILE, SyncEngine, SyncSummary } from "./sync";

interface HashCacheEntry {
	mtime: number;
	size: number;
	hash: string;
	/** Backend id the hash was computed for; stale entries are recomputed. */
	algo: string;
}

interface PluginData {
	settings: SyncSettings;
	/** path -> hash keyed by mtime+size, to avoid re-hashing unchanged files. */
	hashCache: Record<string, HashCacheEntry>;
}

// This must not live in data.json: the vault (and therefore data.json) may be
// synced by iCloud between devices, but the three-way merge base is device-local.
const LOCAL_SYNC_STATE_KEY = "gitee-sync-plus-sync-state-v1";

// Keychain IDs used with app.secretStorage. When available, the in-memory token
// is restored from / written to the OS keychain, and data.json only stores an
// empty string in the token field so the vault sync never carries the real value.
const SECRET_GITEE = "gitee-sync-plus-gitee";
const SECRET_GITHUB = "gitee-sync-plus-github";

export default class CloudSyncPlugin extends Plugin {
	settings: SyncSettings = { ...DEFAULT_SETTINGS };
	syncState: Record<string, string> = {};
	hashCache: Record<string, HashCacheEntry> = {};
	gitIgnoreManager!: GitIgnoreManager;

	private statusBar!: HTMLElement;
	private syncing = false;
	private autoSyncTimer: number | null = null;

	/** Ribbon icon references so they can be dynamically shown/hidden. */
	private syncRibbonIcon?: HTMLElement;
	private panelRibbonIcon?: HTMLElement;

	async onload(): Promise<void> {
		await this.loadPluginData();
		const l = messages();

		this.gitIgnoreManager = new GitIgnoreManager(this.app.vault);
		await this.gitIgnoreManager.ensureExists();
		await this.migrateLegacyExclusions();
		await this.gitIgnoreManager.load();
		setDiffPluginInstance(this);

		this.addSettingTab(new SyncSettingTab(this.app, this));
		this.statusBar = this.addStatusBarItem();
		this.statusBar.addClass("mod-clickable");
		this.statusBar.setAttribute("aria-label", l.clickToSync);
		this.statusBar.addEventListener("click", () => void this.runSync());
		this.setStatus(l.statusIdle);

		this.addCommand({
			id: "sync-now",
			name: l.commandSyncNow,
			callback: () => void this.runSync(),
		});
		this.addCommand({
			id: "sync-preview",
			name: l.commandPreview,
			callback: () => void this.runPreview(),
		});

		if (this.settings.showSyncRibbon) {
			this.syncRibbonIcon = this.addRibbonIcon("refresh-cw", l.ribbonSync, () => void this.runSync());
		}

		this.registerView(GIT_PANEL_VIEW_TYPE, (leaf) => new GitPanelView(leaf, this));
		this.registerView(DIFF_VIEW_TYPE, (leaf) => new DiffView(leaf));
		if (this.settings.showPanelRibbon) {
			this.panelRibbonIcon = this.addRibbonIcon("git-pull-request-arrow", l.panelRibbon, () => void this.activateGitPanel());
		}
		this.addCommand({
			id: "open-git-panel",
			name: l.panelOpenCommand,
			callback: () => void this.activateGitPanel(),
		});

		this.setupAutoSync();
		if (this.settings.syncOnStart) {
			this.app.workspace.onLayoutReady(() => void this.runSync(true));
		}
	}

	onunload(): void {
		this.clearAutoSync();
	}

	/** Migrates the legacy "Excluded folders" setting into .gitignore and clears it. */
	private async migrateLegacyExclusions(): Promise<void> {
		const legacy = this.settings.excludeFolders?.trim();
		if (legacy) {
			await this.gitIgnoreManager.writeManagedFolders(legacy);
			this.settings.excludeFolders = "";
			await this.savePluginData();
		}
	}

	setupAutoSync(): void {
		this.clearAutoSync();
		const minutes = this.settings.autoSyncMinutes;
		if (minutes > 0) {
			this.autoSyncTimer = window.setInterval(
				() => void this.runSync(true),
				minutes * 60 * 1000
			);
			this.registerInterval(this.autoSyncTimer);
		}
	}

	private clearAutoSync(): void {
		if (this.autoSyncTimer !== null) {
			window.clearInterval(this.autoSyncTimer);
			this.autoSyncTimer = null;
		}
	}

	/** Show or hide ribbon icons based on current settings. Called when settings change. */
	updateRibbonIcons(): void {
		const l = messages();
		// Sync ribbon
		if (this.settings.showSyncRibbon && !this.syncRibbonIcon) {
			this.syncRibbonIcon = this.addRibbonIcon("refresh-cw", l.ribbonSync, () => void this.runSync());
		} else if (!this.settings.showSyncRibbon && this.syncRibbonIcon) {
			this.syncRibbonIcon.remove();
			this.syncRibbonIcon = undefined;
		}
		// Panel ribbon
		if (this.settings.showPanelRibbon && !this.panelRibbonIcon) {
			this.panelRibbonIcon = this.addRibbonIcon("git-pull-request-arrow", l.panelRibbon, () => void this.activateGitPanel());
		} else if (!this.settings.showPanelRibbon && this.panelRibbonIcon) {
			this.panelRibbonIcon.remove();
			this.panelRibbonIcon = undefined;
		}
	}

	async runSync(silent = false): Promise<void> {
		const l = messages();
		if (this.syncing) {
			if (!silent) new Notice(l.syncInProgress);
			return;
		}
		this.syncing = true;
		this.setStatus(l.statusRunning);
		try {
			const summary = await new SyncEngine(this).run();
			this.setStatus(l.statusComplete(formatTime()));
			const changed =
				summary.pushed + summary.pulled + summary.deletedLocal + summary.deletedRemote;
			if (!silent || changed > 0) {
				new Notice(this.formatSummary(summary));
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.setStatus(l.statusFailed);
			new Notice(l.syncFailed(msg), 8000);
			console.error("[gitee-sync-plus]", e);
		} finally {
			this.syncing = false;
		}
	}

	async runPreview(): Promise<void> {
		const l = messages();
		if (this.syncing) {
			new Notice(l.previewWhileSyncing);
			return;
		}
		try {
			const { plan, report } = await new SyncEngine(this).preview();
			await this.appendLog(report);
			new Notice(
				l.previewComplete(
					plan.pulls.length,
					plan.pushes.length,
					plan.localDeletes.length,
					plan.remoteDeletes.length,
					LOG_FILE
				)
			);
			await this.app.workspace.openLinkText(LOG_FILE, "", true);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(l.previewFailed(msg), 8000);
			await this.appendLog(l.previewFailedLog(formatDateTime(), msg));
		}
	}

	/** Opens (or focuses) the Git panel in the right sidebar. */
	async activateGitPanel(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(GIT_PANEL_VIEW_TYPE)[0];
		if (!leaf) {
			const sideLeaf = workspace.getRightLeaf(false) ?? workspace.getRightLeaf(true);
			if (!sideLeaf) return;
			leaf = sideLeaf;
			await leaf.setViewState({ type: GIT_PANEL_VIEW_TYPE, active: true });
		}
		workspace.revealLeaf(leaf);
	}

	/** Shows a Notice summarizing a sync result (used by the Git panel). */
	announceSummary(s: SyncSummary): void {
		new Notice(this.formatSummary(s));
	}

	/** Appends to the diagnostic note (which is itself excluded from sync). */
	async appendLog(text: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(LOG_FILE))) {
			await adapter.write(LOG_FILE, messages().diagnosticLogTitle);
		}
		await adapter.append(LOG_FILE, text);
	}

	private formatSummary(s: SyncSummary): string {
		const l = messages();
		const parts: string[] = [];
		if (s.pushed) parts.push(l.summaryUpload(s.pushed));
		if (s.pulled) parts.push(l.summaryDownload(s.pulled));
		if (s.deletedRemote) parts.push(l.summaryDeleteRemote(s.deletedRemote));
		if (s.deletedLocal) parts.push(l.summaryDeleteLocal(s.deletedLocal));
		if (s.conflicts) parts.push(l.summaryConflict(s.conflicts));
		return parts.length ? l.summaryComplete(parts.join(", ")) : l.summaryNoChanges;
	}

	private setStatus(text: string): void {
		this.statusBar.setText(text);
	}

	async loadPluginData(): Promise<void> {
		const data = (await this.loadData()) as Partial<PluginData> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...data?.settings };
		// Migrate configs that predate the removal of the Cloudflare Worker backend.
		if (this.settings.backend !== "gitee" && this.settings.backend !== "github") {
			this.settings.backend = "gitee";
		}
		// Prefer the keychain value over the data.json placeholder. On mobile /
		// pre-1.11.4 Obsidian there is no secretStorage, so data.json holds the
		// only copy of the token.
		if (this.app.secretStorage) {
			try {
				const gitee = this.app.secretStorage.getSecret(SECRET_GITEE);
				const github = this.app.secretStorage.getSecret(SECRET_GITHUB);
				if (gitee) this.settings.giteeToken = gitee;
				if (github) this.settings.githubToken = github;
			} catch {
				/* keep whatever data.json provided */
			}
		}
		this.syncState =
			(this.app.loadLocalStorage(LOCAL_SYNC_STATE_KEY) as Record<string, string> | null) ?? {};
		this.hashCache = data?.hashCache ?? {};
	}

	/**
	 * Called whenever the plugin has a chance to persist secrets. When the OS
	 * keychain is available, the in-memory token is mirrored there and the
	 * data.json copy is redacted (empty string) so the vault sync never carries
	 * the real token. Returns true when at least one token was written.
	 */
	async savePluginData(): Promise<void> {
		this.app.saveLocalStorage(LOCAL_SYNC_STATE_KEY, this.syncState);
		const ss = this.app.secretStorage;
		const persist = {
			...this.settings,
			// When the keychain is available, blank the on-disk token so the
			// vault sync cannot leak it. The in-memory value stays intact.
			giteeToken: ss && this.settings.giteeToken ? "" : this.settings.giteeToken,
			githubToken: ss && this.settings.githubToken ? "" : this.settings.githubToken,
		};
		if (ss) {
			try {
				if (this.settings.giteeToken) ss.setSecret(SECRET_GITEE, this.settings.giteeToken);
				if (this.settings.githubToken) ss.setSecret(SECRET_GITHUB, this.settings.githubToken);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				new Notice(messages().keychainMigrateFailed(msg), 8000);
				// Fall through and persist as-is so the user is not locked out.
			}
		}
		const data: PluginData = { settings: persist, hashCache: this.hashCache };
		await this.saveData(data);
		this.notifyGitPanelsOfSettingsChange();
	}

	/**
	 * One-shot helper that moves any plaintext token still living in data.json
	 * into the OS keychain. Safe to call repeatedly: if the keychain is missing
	 * or there is nothing to migrate, this is a no-op.
	 */
	async migrateTokensToKeychain(): Promise<boolean> {
		const ss = this.app.secretStorage;
		if (!ss) return false;
		const raw = (await this.loadData()) as Partial<PluginData> | null;
		const disk: Partial<SyncSettings> = raw?.settings ?? {};
		const pendingGitee = disk.giteeToken ?? "";
		const pendingGithub = disk.githubToken ?? "";
		if (!pendingGitee && !pendingGithub) return false;
		try {
			if (pendingGitee) ss.setSecret(SECRET_GITEE, pendingGitee);
			if (pendingGithub) ss.setSecret(SECRET_GITHUB, pendingGithub);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(messages().keychainMigrateFailed(msg), 8000);
			return false;
		}
		await this.savePluginData();
		new Notice(messages().keychainMigrated);
		return true;
	}

	/** Notify all open Git panels that settings have changed so they update their target label and refresh. */
	private notifyGitPanelsOfSettingsChange(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(GIT_PANEL_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof GitPanelView) {
				view.onSettingsChanged();
			}
		}
	}
}
