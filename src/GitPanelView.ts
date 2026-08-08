import { App, ItemView, Modal, Notice, WorkspaceLeaf } from "obsidian";
import type CloudSyncPlugin from "./main";
import { messages } from "./i18n";
import { SyncEngine, SyncPlan } from "./sync";
import type { RemoteEntry } from "./backend";
import { DiffKind, openDiffView } from "./DiffView";

export const GIT_PANEL_VIEW_TYPE = "gitee-sync-plus-git-panel";

type ItemKind = "mod" | "add" | "del" | "remote";

interface PanelItem {
	path: string;
	tag: string;
	kind: ItemKind;
	discardable: boolean;
	group: "local" | "remote";
}

/** Destructive-action confirm modal (discard local changes). */
class DiscardConfirmModal extends Modal {
	private readonly message: string;
	private readonly onConfirm: () => void;

	constructor(app: App, message: string, onConfirm: () => void) {
		super(app);
		this.message = message;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const l = messages();
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: l.panelDiscardConfirmTitle });
		contentEl.createEl("p", { text: this.message });
		const row = contentEl.createDiv("modal-button-row");
		row
			.createEl("button", { text: l.cancel, cls: "mod-cancel" })
			.addEventListener("click", () => this.close());
		const ok = row.createEl("button", { text: l.panelDiscard, cls: "mod-warning" });
		ok.addEventListener("click", () => {
			this.close();
			this.onConfirm();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Sidebar "Git panel" — a lightweight source-control view that mirrors the
 * IDE source-control sidebar, except it operates on the plugin's three-way
 * sync model (no local git binary required).
 *
 *  - Local changes  → files the plugin will push on the next sync.
 *  - Remote changes → files the plugin will pull / delete locally.
 *  - Commit → push local changes (Phase 2), optionally with a custom message.
 *  - Pull   → download remote changes (Phase 1).
 *  - Discard → revert a local change to the last-synced remote version.
 */
export class GitPanelView extends ItemView {
	private readonly plugin: CloudSyncPlugin;
	private readonly engine: SyncEngine;
	private plan: SyncPlan | null = null;
	private messageEl!: HTMLTextAreaElement;
	private listEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private busy = false;
	private refreshTimer: number | null = null;
	/** Paths selected for the next commit. Reset when a commit succeeds. */
	private staged = new Set<string>();

	constructor(leaf: WorkspaceLeaf, plugin: CloudSyncPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.engine = new SyncEngine(plugin);
	}

	getViewType(): string {
		return GIT_PANEL_VIEW_TYPE;
	}

	getDisplayText(): string {
		return messages().panelTitle;
	}

	getIcon(): string {
		return "git-pull-request";
	}

	async onOpen(): Promise<void> {
		const l = messages();
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("gitee-sync-plus-panel");

		// Header
		const header = container.createDiv("gitee-sync-plus-panel-header");
		header.createSpan({ text: l.panelTitle, cls: "gitee-sync-plus-panel-title" });
		this.statusEl = header.createSpan({ cls: "gitee-sync-plus-panel-status" });

		// Target repo / branch
		const info = container.createDiv("gitee-sync-plus-panel-info");
		info.setText(this.targetLabel());

		// Commit message
		const msgWrap = container.createDiv("gitee-sync-plus-panel-message");
		this.messageEl = msgWrap.createEl("textarea", {
			placeholder: l.panelMessagePlaceholder,
			cls: "gitee-sync-plus-panel-textarea",
		});
		container.createDiv({ text: l.panelCommitHint, cls: "gitee-sync-plus-panel-hint" });
		// Ctrl/Cmd+Enter commits
		this.messageEl.addEventListener("keydown", (e) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
				e.preventDefault();
				void this.onCommit();
			}
		});

		// Action buttons
		const btnRow = container.createDiv("gitee-sync-plus-panel-buttons");
		btnRow
			.createEl("button", { text: l.panelCommit, cls: "mod-cta gitee-sync-plus-panel-btn" })
			.addEventListener("click", () => void this.onCommit());
		btnRow
			.createEl("button", { text: l.panelPull, cls: "gitee-sync-plus-panel-btn" })
			.addEventListener("click", () => void this.onPull());
		btnRow
			.createEl("button", { text: l.panelRefresh, cls: "gitee-sync-plus-panel-btn" })
			.addEventListener("click", () => void this.refresh());

		// Changes list
		this.listEl = container.createDiv("gitee-sync-plus-panel-list");

		// Auto-refresh when the vault changes (debounced).
		this.registerEvent(this.app.vault.on("modify", () => this.scheduleRefresh()));
		this.registerEvent(this.app.vault.on("create", () => this.scheduleRefresh()));
		this.registerEvent(this.app.vault.on("delete", () => this.scheduleRefresh()));
		this.registerEvent(this.app.vault.on("rename", () => this.scheduleRefresh()));

		await this.refresh();
	}

	async onClose(): Promise<void> {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = null;
	}

	private targetLabel(): string {
		const s = this.plugin.settings;
		if (s.backend === "github") {
			return `github: ${s.githubOwner}/${s.githubRepo}@${s.githubBranch}`;
		}
		return `gitee: ${s.giteeOwner}/${s.giteeRepo}@${s.giteeBranch}`;
	}

	private setStatus(text: string): void {
		if (this.statusEl) this.statusEl.setText(text);
	}

	private scheduleRefresh(): void {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			void this.refresh();
		}, 1500);
	}

	async refresh(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		const l = messages();
		try {
			this.setStatus(l.panelStatusComputing);
			this.plan = await this.engine.computePlan();
			this.renderList();
			this.setStatus(l.panelStatusChanges(this.changeCount()));
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.setStatus(l.panelStatusError(msg));
		} finally {
			this.busy = false;
		}
	}

	private changeCount(): number {
		const p = this.plan;
		if (!p) return 0;
		return p.pulls.length + p.pushes.length + p.localDeletes.length + p.remoteDeletes.length;
	}

	private renderList(): void {
		const l = messages();
		const p = this.plan;
		this.listEl.empty();
		if (!p) return;

		// Remove staged paths that no longer appear in the current plan.
		const localChangePaths = new Set<string>([
			...p.pushes.map((x) => x.path),
			...p.remoteDeletes.map((x) => x.path),
		]);
		for (const path of this.staged) {
			if (!localChangePaths.has(path)) this.staged.delete(path);
		}

		const makeLocalItem = (
			x: { path: string; rem?: RemoteEntry },
			kind: ItemKind,
			tag: string
		): PanelItem => ({
			path: x.path,
			tag,
			kind,
			discardable: true,
			group: "local" as const,
		});

		const unstagedItems: PanelItem[] = [
			...p.pushes
				.filter((x) => !this.staged.has(x.path))
				.map((x) => makeLocalItem(x, x.rem ? "mod" : "add", x.rem ? l.statusTagModified : l.statusTagAdded)),
			...p.remoteDeletes
				.filter((x) => !this.staged.has(x.path))
				.map((x) => makeLocalItem(x, "del", l.statusTagDeleted)),
		];
		const stagedItems: PanelItem[] = [
			...p.pushes
				.filter((x) => this.staged.has(x.path))
				.map((x) => makeLocalItem(x, x.rem ? "mod" : "add", x.rem ? l.statusTagModified : l.statusTagAdded)),
			...p.remoteDeletes
				.filter((x) => this.staged.has(x.path))
				.map((x) => makeLocalItem(x, "del", l.statusTagDeleted)),
		];
		const remoteItems: PanelItem[] = [
			...p.pulls.map((x) => ({
				path: x.path,
				tag: l.statusTagRemote,
				kind: "remote" as ItemKind,
				discardable: false,
				group: "remote" as const,
			})),
			...p.localDeletes.map((x) => ({
				path: x.path,
				tag: l.statusTagDeleted,
				kind: "del" as ItemKind,
				discardable: false,
				group: "remote" as const,
			})),
		];

		if (stagedItems.length === 0 && unstagedItems.length === 0 && remoteItems.length === 0) {
			this.listEl.createDiv({ text: l.panelNoChanges, cls: "gitee-sync-plus-panel-empty" });
			return;
		}

		if (stagedItems.length > 0) {
			this.renderGroup(l.panelGroupStaged, stagedItems, "staged", {
				unstageAll: () => this.onUnstageAll(),
			});
		}
		if (unstagedItems.length > 0) {
			this.renderGroup(l.panelGroupUnstaged, unstagedItems, "unstaged", {
				stageAll: () => this.onStageAll(),
				discardAll: () => this.onDiscardAll(),
			});
		}
		if (remoteItems.length > 0) {
			this.renderGroup(l.panelGroupRemote, remoteItems);
		}
	}

	private renderGroup(
		title: string,
		items: PanelItem[],
		mode?: "staged" | "unstaged",
		actions?: { stageAll?: () => void; unstageAll?: () => void; discardAll?: () => void }
	): void {
		const l = messages();
		const group = this.listEl.createDiv("gitee-sync-plus-panel-group");
		const header = group.createDiv("gitee-sync-plus-panel-group-header");
		header.createSpan({
			text: `${title} (${items.length})`,
			cls: "gitee-sync-plus-panel-group-title",
		});
		const headerBtns = header.createDiv("gitee-sync-plus-panel-group-actions");
		if (actions?.stageAll) {
			const btn = headerBtns.createEl("button", {
				text: "+",
				cls: "gitee-sync-plus-panel-icon-btn",
				title: l.panelStageAllHint,
			});
			btn.addEventListener("click", actions.stageAll);
		}
		if (actions?.unstageAll) {
			const btn = headerBtns.createEl("button", {
				text: "-",
				cls: "gitee-sync-plus-panel-icon-btn",
				title: l.panelUnstageAllHint,
			});
			btn.addEventListener("click", actions.unstageAll);
		}
		if (actions?.discardAll) {
			const btn = headerBtns.createEl("button", {
				text: "↩",
				cls: "gitee-sync-plus-panel-icon-btn",
				title: l.panelDiscardAll,
			});
			btn.addEventListener("click", actions.discardAll);
		}
		if (items.length === 0) {
			group.createDiv({
				text: l.panelGroupEmpty,
				cls: "gitee-sync-plus-panel-group-empty",
			});
			return;
		}
		for (const item of items) {
			const row = group.createDiv("gitee-sync-plus-panel-item");

			row.createSpan({
				text: item.tag,
				cls: `gitee-sync-plus-panel-item-status s-${item.kind}`,
			});
			row.createSpan({ text: item.path, cls: "gitee-sync-plus-panel-item-path" });

			if (mode === "unstaged") {
				const btn = row.createEl("button", {
					text: "+",
					cls: "gitee-sync-plus-panel-icon-btn gitee-sync-plus-panel-item-action gitee-sync-plus-panel-stage-btn",
					title: l.panelStage,
				});
				btn.addEventListener("click", (e) => {
					e.stopPropagation();
					this.toggleStage(item.path, true);
				});
			} else if (mode === "staged") {
				const btn = row.createEl("button", {
					text: "-",
					cls: "gitee-sync-plus-panel-icon-btn gitee-sync-plus-panel-item-action gitee-sync-plus-panel-stage-btn",
					title: l.panelUnstage,
				});
				btn.addEventListener("click", (e) => {
					e.stopPropagation();
					this.toggleStage(item.path, false);
				});
			}
			if (item.discardable) {
				const btn = row.createEl("button", {
					text: "↩",
					cls: "gitee-sync-plus-panel-icon-btn gitee-sync-plus-panel-item-action",
					title: l.panelDiscard,
				});
				btn.addEventListener("click", (e) => {
					e.stopPropagation();
					this.onDiscard(item.path);
				});
			}
			const viewBtn = row.createEl("button", {
				text: "👁",
				cls: "gitee-sync-plus-panel-icon-btn gitee-sync-plus-panel-item-action",
				title: l.panelViewDiff,
			});
			viewBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.openDiff(item);
			});
		}
	}

	private openDiff(item: PanelItem): void {
		const kind = this.mapKind(item);
		void openDiffView(this.plugin, item.path, kind);
	}

	private mapKind(item: PanelItem): DiffKind {
		if (item.group === "local") {
			if (item.kind === "add") return "local-add";
			if (item.kind === "del") return "local-del";
			return "local-mod";
		}
		if (item.kind === "del") return "remote-del";
		return "remote-mod";
	}

	private onDiscard(path: string): void {
		const l = messages();
		new DiscardConfirmModal(this.app, l.panelDiscardConfirm(path), () =>
			void this.doDiscard([path])
		).open();
	}

	private onDiscardAll(): void {
		const l = messages();
		if (!this.plan) return;
		const paths = [
			...this.plan.pushes.filter((x) => !this.staged.has(x.path)).map((x) => x.path),
			...this.plan.remoteDeletes.filter((x) => !this.staged.has(x.path)).map((x) => x.path),
		];
		if (paths.length === 0) return;
		new DiscardConfirmModal(this.app, l.panelDiscardAllConfirm(paths.length), () =>
			void this.doDiscard(paths)
		).open();
	}

	private toggleStage(path: string, checked: boolean): void {
		if (checked) this.staged.add(path);
		else this.staged.delete(path);
		this.renderList();
	}

	private onStageAll(): void {
		if (!this.plan) return;
		for (const p of this.plan.pushes) this.staged.add(p.path);
		for (const d of this.plan.remoteDeletes) this.staged.add(d.path);
		this.renderList();
	}

	private onUnstageAll(): void {
		this.staged.clear();
		this.renderList();
	}

	private async doDiscard(paths: string[]): Promise<void> {
		if (this.busy || !this.plan) return;
		this.busy = true;
		try {
			const n = await this.engine.discardChanges(this.plan, paths);
			new Notice(messages().panelDiscarded(n));
			await this.refresh();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(messages().panelDiscardFailed(msg), 8000);
		} finally {
			this.busy = false;
		}
	}

	private async onCommit(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		const l = messages();
		this.setStatus(l.panelStatusWorking);
		try {
			const msg = this.messageEl.value.trim() || undefined;
			if (this.staged.size === 0) {
				new Notice(l.panelNothingStaged, 4000);
				return;
			}
			const summary = await this.engine.pushLocal(msg, new Set(this.staged));
			this.staged.clear();
			this.messageEl.value = "";
			this.plugin.announceSummary(summary);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.setStatus(l.panelStatusError(msg));
			new Notice(l.syncFailed(msg), 8000);
		} finally {
			this.busy = false;
		}
		// Refresh AFTER releasing the busy flag — otherwise refresh()'s
		// `if (this.busy) return` guard would skip the repaint and the staged
		// list would visually look like it was never cleared.
		await this.refresh();
	}

	private async onPull(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		const l = messages();
		this.setStatus(l.panelStatusWorking);
		try {
			const summary = await this.engine.pullRemote();
			this.plugin.announceSummary(summary);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.setStatus(l.panelStatusError(msg));
			new Notice(l.syncFailed(msg), 8000);
		} finally {
			this.busy = false;
		}
		// Refresh AFTER releasing the busy flag (same guard issue as onCommit).
		await this.refresh();
	}
}
