import { Notice, Plugin } from "obsidian";
import { GitIgnoreManager } from "./gitignore";
import { formatDateTime, formatTime, messages } from "./i18n";
import { DEFAULT_SETTINGS, SyncSettings, SyncSettingTab } from "./settings";
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
const LOCAL_SYNC_STATE_KEY = "gitee-sync-sync-state-v1";

export default class CloudSyncPlugin extends Plugin {
	settings: SyncSettings = { ...DEFAULT_SETTINGS };
	syncState: Record<string, string> = {};
	hashCache: Record<string, HashCacheEntry> = {};
	gitIgnoreManager!: GitIgnoreManager;

	private statusBar!: HTMLElement;
	private syncing = false;
	private autoSyncTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadPluginData();
		const l = messages();

		this.gitIgnoreManager = new GitIgnoreManager(this.app.vault);
		await this.gitIgnoreManager.ensureExists();
		await this.migrateLegacyExclusions();
		await this.gitIgnoreManager.load();

		this.addSettingTab(new SyncSettingTab(this.app, this));
		this.statusBar = this.addStatusBarItem();
		this.statusBar.addClass("mod-clickable");
		this.statusBar.setAttribute("aria-label", l.clickToSync);
		this.statusBar.addEventListener("click", () => void this.runSync());
		this.setStatus(l.statusIdle);

		this.addRibbonIcon("refresh-cw", l.ribbonSync, () => void this.runSync());
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
			console.error("[gitee-sync]", e);
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
		this.syncState =
			(this.app.loadLocalStorage(LOCAL_SYNC_STATE_KEY) as Record<string, string> | null) ?? {};
		this.hashCache = data?.hashCache ?? {};
	}

	async savePluginData(): Promise<void> {
		this.app.saveLocalStorage(LOCAL_SYNC_STATE_KEY, this.syncState);
		const data: PluginData = { settings: this.settings, hashCache: this.hashCache };
		await this.saveData(data);
	}
}
