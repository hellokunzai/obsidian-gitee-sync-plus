import { App, ItemView, Modal, Notice, WorkspaceLeaf } from "obsidian";
import type CloudSyncPlugin from "./main";
import { createBackend } from "./backend";
import { messages } from "./i18n";

export const DIFF_VIEW_TYPE = "gitee-sync-plus-diff";

/** Render tuning: at or below this many rows we build the DOM synchronously;
 * above it we split the work across animation frames so the UI never blocks. */
const BATCH_THRESHOLD = 800;
/** Show a one-time hint when a diff is larger than this many rows. */
const LARGE_FILE_ROWS = 5000;
/** Per-animation-frame work budget (ms) for batched rendering. */
const FRAME_BUDGET_MS = 12;

export type DiffKind = "local-mod" | "local-add" | "local-del" | "remote-mod" | "remote-del";

let pluginInstance: CloudSyncPlugin | undefined;
/** Hands the plugin instance from main.ts to this view, avoiding the undocumented app.plugins API. */
export function setDiffPluginInstance(p: CloudSyncPlugin): void {
	pluginInstance = p;
}

interface DiffState extends Record<string, unknown> {
	path: string;
	kind: DiffKind;
}

interface DiffRow {
	oldLine: number;
	newLine: number;
	oldText: string;
	newText: string;
	state: "equal" | "delete" | "insert" | "change";
	/** Index of the contiguous diff chunk this row belongs to. Equal rows get -1. */
	chunkIndex: number;
}

/**
 * Side-by-side diff view for the Git panel.
 *
 * Does not require a local git binary: the "before" side is either the
 * current remote version (downloaded via the backend) or an empty document,
 * and the "after" side is either the current local file or the remote
 * version, depending on the change direction.
 */
export class DiffView extends ItemView {
	private viewState: DiffState | null = null;
	private diffContentEl: HTMLElement | null = null;
	private busy = false;
	private opened = false;
	private currentBeforeText = "";
	private currentAfterText = "";
	private layout: "side-by-side" | "vertical" = "side-by-side";
	// Collapse unchanged fragments by default: keeps the DOM tiny on large
	// files (e.g. 10k-line data.json) so the diff opens instantly and only
	// expands the few lines of context around each change on demand.
	private collapseUnchanged = true;
	private scrollSyncHandler?: () => void;
	private sectionScrollEls: HTMLElement[] = [];
	/** Monotonic token: every renderDiff bumps it so a stale batched render
	 * (from a view switch or re-render) stops touching the DOM. */
	private renderToken = 0;
	/** chunkIndex → rows in that chunk, built once per render so reverting a
	 * chunk is O(1) instead of O(rows). */
	private chunkRowsIndex = new Map<number, DiffRow[]>();
	private lastDiff: {
		path: string;
		beforeText: string;
		afterText: string;
		beforeLabel: string;
		afterLabel: string;
	} | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	private get plugin(): CloudSyncPlugin {
		if (pluginInstance) return pluginInstance;
		// Fallback for rare cases where the singleton isn't set yet.
		const plugins = (this.app as unknown as { plugins?: { getPlugin: (id: string) => unknown } }).plugins;
		const p = plugins?.getPlugin("gitee-sync-plus") as CloudSyncPlugin | undefined;
		if (!p) throw new Error(messages().diffPluginNotReady);
		return p;
	}

	getViewType(): string {
		return DIFF_VIEW_TYPE;
	}

	getDisplayText(): string {
		const l = messages();
		if (!this.viewState) return l.diffTitle;
		return l.diffTitleFor(this.viewState.path);
	}

	getIcon(): string {
		return "columns-2";
	}

	async setState(state: DiffState, result: any): Promise<void> {
		this.viewState = state;
		await super.setState(state, result);
		// onOpen() may run after setState(); only load once the DOM is ready.
		if (this.opened) {
			void this.loadDiff();
		}
	}

	getState(): DiffState {
		return this.viewState ?? { path: "", kind: "local-mod" };
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("gitee-sync-plus-diff");

		const header = container.createDiv("gitee-sync-plus-diff-header");
		header.createEl("span", { cls: "gitee-sync-plus-diff-path" });
		const actions = header.createDiv("gitee-sync-plus-diff-actions");
		const layoutBtn = actions.createEl("button", {
			cls: "gitee-sync-plus-diff-layout-btn",
			title: messages().diffLayoutToggle,
		});
		layoutBtn.addEventListener("click", () => this.toggleLayout());

		const collapseBtn = actions.createEl("button", {
			cls: "gitee-sync-plus-diff-action-btn gitee-sync-plus-diff-collapse-btn",
			title: messages().diffCollapseUnchanged,
		});
		collapseBtn.addEventListener("click", () => this.toggleCollapseUnchanged());

		this.updateLayoutButton();
		this.updateCollapseButton();

		this.diffContentEl = container.createDiv("gitee-sync-plus-diff-content");

		this.opened = true;
		if (this.viewState) {
			void this.loadDiff();
		}
	}

	private toggleLayout(): void {
		this.layout = this.layout === "side-by-side" ? "vertical" : "side-by-side";
		this.updateLayoutButton();
		// DOM structure differs between layouts, so re-render instead of just swapping a class.
		if (this.lastDiff) {
			this.renderDiff(
				this.lastDiff.path,
				this.lastDiff.beforeText,
				this.lastDiff.afterText,
				this.lastDiff.beforeLabel,
				this.lastDiff.afterLabel
			);
		} else if (this.diffContentEl) {
			this.diffContentEl.removeClass("layout-side-by-side", "layout-vertical");
			this.diffContentEl.addClass(`layout-${this.layout}`);
		}
	}

	private updateLayoutButton(): void {
		const btn = this.containerEl.querySelector(".gitee-sync-plus-diff-layout-btn");
		if (!btn) return;
		const l = messages();
		const title = this.layout === "side-by-side" ? l.diffLayoutVertical : l.diffLayoutSideBySide;
		btn.setAttribute("aria-label", title);
		btn.setAttribute("title", title);
		btn.setText(this.layout === "side-by-side" ? "⇅" : "⇄");
	}

	private toggleCollapseUnchanged(): void {
		this.collapseUnchanged = !this.collapseUnchanged;
		this.updateCollapseButton();
		if (this.diffContentEl) {
			this.diffContentEl.toggleClass("collapse-unchanged", this.collapseUnchanged);
			// When expanding, lazy-load any collapsed runs so their hidden
			// middle lines actually appear (placeholder click does the work).
			if (!this.collapseUnchanged) {
				this.diffContentEl
					.querySelectorAll(".gitee-sync-plus-diff-collapsed-placeholder")
					.forEach((el) => {
						if (el instanceof HTMLElement) el.click();
					});
			}
		}
	}

	private updateCollapseButton(): void {
		const btn = this.containerEl.querySelector(".gitee-sync-plus-diff-collapse-btn");
		if (!btn) return;
		const l = messages();
		const title = this.collapseUnchanged ? l.diffExpandUnchanged : l.diffCollapseUnchanged;
		btn.setAttribute("aria-label", title);
		btn.setAttribute("title", title);
		btn.setText(this.collapseUnchanged ? "≣" : "≡");
		btn.toggleClass("is-active", this.collapseUnchanged);
	}

	private attachScrollSync(): void {
		this.detachScrollSync();
		if (this.sectionScrollEls.length !== 2) return;
		const [left, right] = this.sectionScrollEls;
		let active: HTMLElement | null = null;
		let timeout: number | undefined;
		const onScroll = (source: HTMLElement) => {
			if (active && active !== source) return;
			active = source;
			const target = source === left ? right : left;
			const maxSource = source.scrollHeight - source.clientHeight;
			const maxTarget = target.scrollHeight - target.clientHeight;
			if (maxSource <= 0 || maxTarget <= 0) return;
			const ratio = source.scrollTop / maxSource;
			target.scrollTop = ratio * maxTarget;
			if (timeout) window.clearTimeout(timeout);
			timeout = window.setTimeout(() => {
				active = null;
			}, 100);
		};
		this.scrollSyncHandler = () => {
			if (document.activeElement === left || left.matches(":hover")) onScroll(left);
			else onScroll(right);
		};
		left.addEventListener("scroll", this.scrollSyncHandler);
		right.addEventListener("scroll", this.scrollSyncHandler);
	}

	private detachScrollSync(): void {
		if (!this.scrollSyncHandler || this.sectionScrollEls.length !== 2) return;
		const [left, right] = this.sectionScrollEls;
		left.removeEventListener("scroll", this.scrollSyncHandler);
		right.removeEventListener("scroll", this.scrollSyncHandler);
		this.scrollSyncHandler = undefined;
	}

	private updateTitle(): void {
		const header = this.containerEl.querySelector(".gitee-sync-plus-diff-path");
		if (header) header.setText(this.getDisplayText());
		// Ask Obsidian to refresh the tab label; ignore if the API is unavailable.
		try {
			(this.leaf as unknown as { updateDisplayText?: () => void }).updateDisplayText?.();
		} catch {
			/* ignore */
		}
	}

	private async loadDiff(): Promise<void> {
		if (this.busy || !this.viewState || !this.diffContentEl) return;
		this.busy = true;
		const l = messages();
		this.diffContentEl.empty();
		this.diffContentEl.setText(l.diffLoading);
		this.updateTitle();

		try {
			const { path, kind } = this.viewState;
			const backend = createBackend(this.plugin.settings);

			let beforeText = "";
			let afterText = "";
			let beforeLabel = l.diffLeftLocal;
			let afterLabel = l.diffRightRemote;

			switch (kind) {
			case "local-mod": {
				const { data, hash: remoteHash } = await backend.download(path);
				beforeText = this.decodeText(data);
				afterText = await this.readLocalText(path);
				beforeLabel = l.diffLeftRemote;
				afterLabel = l.diffRightLocal;
				if (this.textsAreEffectivelyEqual(beforeText, afterText)) {
					this.renderIdenticalDiff(path, remoteHash, beforeText, afterText, beforeLabel, afterLabel);
					return;
				}
				break;
			}
				case "local-add": {
					afterText = await this.readLocalText(path);
					beforeLabel = l.diffLeftEmpty;
					afterLabel = l.diffRightLocal;
					break;
				}
				case "local-del": {
					const { data } = await backend.download(path);
					beforeText = this.decodeText(data);
					beforeLabel = l.diffLeftRemote;
					afterLabel = l.diffRightEmpty;
					break;
				}
			case "remote-mod": {
				beforeText = await this.readLocalText(path);
				const { data, hash: remoteHash } = await backend.download(path);
				afterText = this.decodeText(data);
				beforeLabel = l.diffLeftLocal;
				afterLabel = l.diffRightRemote;
				if (this.textsAreEffectivelyEqual(beforeText, afterText)) {
					this.renderIdenticalDiff(path, remoteHash, beforeText, afterText, beforeLabel, afterLabel);
					return;
				}
				break;
			}
				case "remote-del": {
					beforeText = await this.readLocalText(path);
					beforeLabel = l.diffLeftLocal;
					afterLabel = l.diffRightEmpty;
					break;
				}
			}

			await this.renderDiff(path, beforeText, afterText, beforeLabel, afterLabel);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error("[gitee-sync-plus] diff load failed", e);
			this.diffContentEl?.empty();
			this.diffContentEl?.createEl("p", {
				text: l.diffError(msg),
				cls: "gitee-sync-plus-diff-error",
			});
		} finally {
			this.busy = false;
		}
	}

	private async readLocalText(path: string): Promise<string> {
		const data = await this.app.vault.adapter.readBinary(path);
		return this.decodeText(data);
	}

	private decodeText(data: ArrayBuffer): string {
		// Reject obvious binary content.
		const sample = new Uint8Array(data.slice(0, 1024));
		for (let i = 0; i < sample.length; i++) {
			if (sample[i] === 0) {
				throw new Error(messages().diffBinaryFile);
			}
		}
		return new TextDecoder("utf-8", { fatal: true }).decode(data);
	}

	private async renderDiff(
		path: string,
		beforeText: string,
		afterText: string,
		beforeLabel: string,
		afterLabel: string
	): Promise<void> {
		if (!this.diffContentEl) return;
		this.diffContentEl.empty();
		const l = messages();

		const header = this.containerEl.querySelector(".gitee-sync-plus-diff-path");
		if (header) header.setText(`${path} — ${l.diffTitle}`);

		const beforeLines = splitLines(beforeText);
		const afterLines = splitLines(afterText);
		const rows = computeDiffRows(beforeLines, afterLines);
		this.rebuildChunkIndex(rows);
		this.currentBeforeText = beforeText;
		this.currentAfterText = afterText;
		this.lastDiff = { path, beforeText, afterText, beforeLabel, afterLabel };

		this.diffContentEl.removeClass("layout-side-by-side", "layout-vertical");
		this.diffContentEl.addClass(`layout-${this.layout}`);
		this.updateLayoutButton();

		this.sectionScrollEls = [];
		this.detachScrollSync();

		const wrapper = this.diffContentEl.createDiv("gitee-sync-plus-diff-files");

		// Invalidate any in-flight batched render from a previous call.
		const token = ++this.renderToken;

		if (this.layout === "side-by-side") {
			await this.renderSideBySide(wrapper, rows, beforeLabel, afterLabel, token);
		} else {
			await this.renderVertical(wrapper, rows, beforeLabel, afterLabel, token);
		}
		if (token !== this.renderToken || !this.diffContentEl) return;

		this.diffContentEl.toggleClass("collapse-unchanged", this.collapseUnchanged);
		this.updateCollapseButton();
		// Sync scroll is always enabled for both side-by-side and vertical layouts.
		this.attachScrollSync();

		// Warn once for very large files so the user isn't surprised by a
		// slower (but still responsive) render.
		if (rows.length > LARGE_FILE_ROWS) {
			new Notice(messages().diffLargeFileHint(rows.length));
		}
	}

	/**
	 * True when the two texts differ only by line endings (CRLF vs LF) or are
	 * exactly equal. The sync engine normalizes CRLF before hashing on the local
	 * side, but the remote manifest stores the raw git blob SHA; a file uploaded
	 * with CRLF therefore has a different remote hash while being textually
	 * identical. Without this guard the diff view would show two identical panes
	 * for a file the panel lists as changed.
	 */
	private textsAreEffectivelyEqual(a: string, b: string): boolean {
		return normalizeLineEndings(a) === normalizeLineEndings(b);
	}

	/**
	 * Renders a friendly placeholder when the local and remote contents are
	 * textually identical but the sync state says the file changed. Offers a
	 * one-click way to realign the local sync state with the remote hash.
	 */
	private renderIdenticalDiff(
		path: string,
		remoteHash: string,
		beforeText: string,
		afterText: string,
		beforeLabel: string,
		afterLabel: string
	): void {
		if (!this.diffContentEl) return;
		this.diffContentEl.empty();
		const l = messages();

		const container = this.diffContentEl.createDiv("gitee-sync-plus-diff-identical");
		container.createEl("p", {
			text: l.diffIdenticalHint,
			cls: "gitee-sync-plus-diff-identical-hint",
		});

		const actions = container.createDiv("gitee-sync-plus-diff-identical-actions");
		const syncBtn = actions.createEl("button", {
			text: l.diffMarkSynced,
			cls: "mod-cta",
		});
		syncBtn.addEventListener("click", () => void this.markAsSynced(path, remoteHash));

		const showBtn = actions.createEl("button", {
			text: l.diffShowAnyway,
			cls: "gitee-sync-plus-diff-identical-secondary",
		});
		showBtn.addEventListener("click", () =>
			void this.renderDiff(path, beforeText, afterText, beforeLabel, afterLabel)
		);
	}

	private async markAsSynced(path: string, remoteHash: string): Promise<void> {
		const l = messages();
		try {
			this.plugin.syncState[path] = remoteHash;
			await this.plugin.savePluginData();
			new Notice(l.diffMarkedAsSynced(path));
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(l.diffMarkSyncedFailed(msg), 8000);
		}
	}

	private renderSideBySide(
		wrapper: HTMLElement,
		rows: DiffRow[],
		beforeLabel: string,
		afterLabel: string,
		token: number
	): Promise<void> {
		const section = wrapper.createDiv("gitee-sync-plus-diff-section gitee-sync-plus-diff-section-wide");
		const header = section.createDiv("gitee-sync-plus-diff-section-labels");
		header.createSpan({ cls: "gitee-sync-plus-diff-section-label-left", text: beforeLabel });
		header.createSpan({ cls: "gitee-sync-plus-diff-section-label-right", text: afterLabel });

		const scrollBox = section.createDiv("gitee-sync-plus-diff-section-scroll");
		const table = scrollBox.createEl("table", { cls: "gitee-sync-plus-diff-table" });
		this.sectionScrollEls.push(scrollBox);

		const segments = this.buildRowSegments(rows);

		// Small files: render synchronously (fast path, no frame splitting).
		if (rows.length <= BATCH_THRESHOLD) {
			for (const seg of segments) {
				if (token !== this.renderToken) return Promise.resolve();
				this.renderSideBySideSegment(table, seg, rows);
			}
			return Promise.resolve();
		}

		// Large files: render segment-by-segment, yielding to the event loop
		// between segments so the UI stays responsive. Long equal runs only
		// render their context + a placeholder (hidden middle lines are
		// lazy-loaded on expand), keeping the DOM tiny regardless of file size.
		return this.renderSegmentsBatched(
			token,
			segments,
			(seg) => this.renderSideBySideSegment(table, seg, rows)
		);
	}

	private renderSideBySideSegment(
		table: HTMLElement,
		seg: { type: "equal" | "diff"; start: number; end: number },
		rows: DiffRow[]
	): void {
		const l = messages();
		const CONTEXT_LINES = 2;
		const len = seg.end - seg.start + 1;

		if (seg.type === "diff" || len <= CONTEXT_LINES * 2) {
			const tbody = table.createEl("tbody");
			for (let i = seg.start; i <= seg.end; i++) {
				this.renderSideBySideRow(tbody, rows[i], rows[i].chunkIndex >= 0 ? rows[i].chunkIndex : undefined);
			}
			return;
		}

		const group = table.createEl("tbody", { cls: "gitee-sync-plus-diff-collapsed-body" });
		for (let i = seg.start; i < seg.start + CONTEXT_LINES; i++) {
			this.renderSideBySideRow(group, rows[i], rows[i].chunkIndex >= 0 ? rows[i].chunkIndex : undefined);
		}

		const hiddenCount = len - CONTEXT_LINES * 2;
		const placeholder = group.createEl("tr", {
			cls: "gitee-sync-plus-diff-row gitee-sync-plus-diff-collapsed-placeholder",
		});
		placeholder.createEl("td", { cls: "gitee-sync-plus-diff-num" }).setText("⋯");
		placeholder.createEl("td", { cls: "gitee-sync-plus-diff-cell" });
		placeholder.createEl("td", { cls: "gitee-sync-plus-diff-num" }).setText("⋯");
		placeholder.createEl("td", { cls: "gitee-sync-plus-diff-cell" }).setText(l.diffUnchangedLines(hiddenCount));
		// Lazy-load the hidden middle lines only on first expand. A 10k-line
		// unchanged block then costs ~5 DOM rows instead of ~10k.
		placeholder.addEventListener("click", () => {
			if (!group.hasAttribute("data-expanded")) {
				group.setAttribute("data-expanded", "1");
				const frag = document.createDocumentFragment();
				for (let i = seg.start + CONTEXT_LINES; i <= seg.end - CONTEXT_LINES; i++) {
					frag.appendChild(
						this.buildSideBySideRow(rows[i], rows[i].chunkIndex >= 0 ? rows[i].chunkIndex : undefined, true)
					);
				}
				placeholder.after(frag);
			}
			group.toggleClass("is-expanded", true);
		});

		for (let i = seg.end - CONTEXT_LINES + 1; i <= seg.end; i++) {
			this.renderSideBySideRow(group, rows[i], rows[i].chunkIndex >= 0 ? rows[i].chunkIndex : undefined);
		}
	}

	private renderSideBySideRow(
		parent: HTMLElement,
		row: DiffRow,
		chunkIndex: number | undefined,
		collapsible = false
	): void {
		parent.appendChild(this.buildSideBySideRow(row, chunkIndex, collapsible));
	}

	/** Builds a side-by-side diff row element. Uses the native DOM API (not
	 * Obsidian's createEl) so the same helper can append into a tbody or a
	 * DocumentFragment when lazy-loading collapsed unchanged runs. */
	private buildSideBySideRow(row: DiffRow, chunkIndex: number | undefined, collapsible: boolean): HTMLTableRowElement {
		const l = messages();
		const tr = document.createElement("tr");
		tr.className = collapsible
			? `gitee-sync-plus-diff-row gitee-sync-plus-diff-collapsible state-${row.state}`
			: `gitee-sync-plus-diff-row state-${row.state}`;

		const leftNum = document.createElement("td");
		leftNum.className = "gitee-sync-plus-diff-num";
		leftNum.textContent = row.oldLine > 0 ? String(row.oldLine) : "";

		const leftCell = document.createElement("td");
		leftCell.className = `gitee-sync-plus-diff-cell ${row.oldLine === 0 ? "gitee-sync-plus-diff-empty" : ""}`;
		leftCell.textContent = row.oldText;

		const rightNum = document.createElement("td");
		rightNum.className = "gitee-sync-plus-diff-num";
		rightNum.textContent = row.newLine > 0 ? String(row.newLine) : "";

		const rightCell = document.createElement("td");
		rightCell.className = `gitee-sync-plus-diff-cell ${row.newLine === 0 ? "gitee-sync-plus-diff-empty" : ""}`;
		rightCell.textContent = row.newText;

		tr.append(leftNum, leftCell, rightNum, rightCell);

		if (chunkIndex !== undefined) {
			// Place a revert button on whichever side actually shows content for this row:
			// delete -> left (before), insert -> right (after), change -> both.
			const attach = (numCell: HTMLElement) => {
				const revertBtn = document.createElement("button");
				revertBtn.textContent = "↩";
				revertBtn.title = l.diffRevertChunk;
				revertBtn.className = "gitee-sync-plus-diff-revert-btn";
				revertBtn.addEventListener("click", (evt) => {
					evt.stopPropagation();
					void this.onRevertChunk(chunkIndex);
				});
				numCell.appendChild(revertBtn);
			};
			if (row.oldLine > 0) attach(leftNum);
			if (row.newLine > 0) attach(rightNum);
		}
		return tr;
	}

	private renderVertical(
		wrapper: HTMLElement,
		rows: DiffRow[],
		beforeLabel: string,
		afterLabel: string,
		token: number
	): Promise<void> {
		const beforeSection = wrapper.createDiv("gitee-sync-plus-diff-section gitee-sync-plus-diff-section-before");
		beforeSection.createDiv("gitee-sync-plus-diff-section-label").setText(beforeLabel);
		const beforeScroll = beforeSection.createDiv("gitee-sync-plus-diff-section-scroll");
		const beforeTable = beforeScroll.createEl("table", { cls: "gitee-sync-plus-diff-section-table" });
		this.sectionScrollEls.push(beforeScroll);

		const afterSection = wrapper.createDiv("gitee-sync-plus-diff-section gitee-sync-plus-diff-section-after");
		afterSection.createDiv("gitee-sync-plus-diff-section-label").setText(afterLabel);
		const afterScroll = afterSection.createDiv("gitee-sync-plus-diff-section-scroll");
		const afterTable = afterScroll.createEl("table", { cls: "gitee-sync-plus-diff-section-table" });
		this.sectionScrollEls.push(afterScroll);

		const segments = this.buildRowSegments(rows);
		if (rows.length <= BATCH_THRESHOLD) {
			for (const seg of segments) {
				if (token !== this.renderToken) return Promise.resolve();
				this.renderVerticalSegment(beforeTable, afterTable, seg, rows);
			}
			return Promise.resolve();
		}
		return this.renderSegmentsBatched(
			token,
			segments,
			(seg) => this.renderVerticalSegment(beforeTable, afterTable, seg, rows)
		);
	}

	private renderVerticalSegment(
		beforeTable: HTMLElement,
		afterTable: HTMLElement,
		seg: { type: "equal" | "diff"; start: number; end: number },
		rows: DiffRow[]
	): void {
		const l = messages();
		const CONTEXT_LINES = 2;
		const len = seg.end - seg.start + 1;

		if (seg.type === "diff" || len <= CONTEXT_LINES * 2) {
			const beforeBody = beforeTable.createEl("tbody");
			const afterBody = afterTable.createEl("tbody");
			for (let i = seg.start; i <= seg.end; i++) {
				this.renderVerticalRows(beforeBody, afterBody, rows[i], rows[i].chunkIndex >= 0 ? rows[i].chunkIndex : undefined);
			}
			return;
		}

		const beforeGroup = beforeTable.createEl("tbody", { cls: "gitee-sync-plus-diff-collapsed-body" });
		const afterGroup = afterTable.createEl("tbody", { cls: "gitee-sync-plus-diff-collapsed-body" });

		for (let i = seg.start; i < seg.start + CONTEXT_LINES; i++) {
			this.renderVerticalRows(beforeGroup, afterGroup, rows[i], rows[i].chunkIndex >= 0 ? rows[i].chunkIndex : undefined);
		}

		const hiddenCount = len - CONTEXT_LINES * 2;
		const beforePlaceholder = beforeGroup.createEl("tr", {
			cls: "gitee-sync-plus-diff-row gitee-sync-plus-diff-collapsed-placeholder",
		});
		beforePlaceholder.createEl("td", { cls: "gitee-sync-plus-diff-num" }).setText("⋯");
		beforePlaceholder.createEl("td", { cls: "gitee-sync-plus-diff-cell" });

		const afterPlaceholder = afterGroup.createEl("tr", {
			cls: "gitee-sync-plus-diff-row gitee-sync-plus-diff-collapsed-placeholder",
		});
		afterPlaceholder.createEl("td", { cls: "gitee-sync-plus-diff-num" }).setText("⋯");
		afterPlaceholder.createEl("td", { cls: "gitee-sync-plus-diff-cell" }).setText(l.diffUnchangedLines(hiddenCount));

		// Lazy-load the hidden middle lines on first expand (one fragment per
		// side so the two panes stay in sync).
		const expand = () => {
			if (!beforeGroup.hasAttribute("data-expanded")) {
				beforeGroup.setAttribute("data-expanded", "1");
				const beforeFrag = document.createDocumentFragment();
				const afterFrag = document.createDocumentFragment();
				for (let i = seg.start + CONTEXT_LINES; i <= seg.end - CONTEXT_LINES; i++) {
					const { before, after } = this.buildVerticalRows(
						rows[i],
						rows[i].chunkIndex >= 0 ? rows[i].chunkIndex : undefined,
						true
					);
					beforeFrag.appendChild(before);
					afterFrag.appendChild(after);
				}
				beforePlaceholder.after(beforeFrag);
				afterPlaceholder.after(afterFrag);
			}
			beforeGroup.toggleClass("is-expanded", true);
			afterGroup.toggleClass("is-expanded", true);
		};
		beforePlaceholder.addEventListener("click", expand);
		afterPlaceholder.addEventListener("click", expand);

		for (let i = seg.end - CONTEXT_LINES + 1; i <= seg.end; i++) {
			this.renderVerticalRows(beforeGroup, afterGroup, rows[i], rows[i].chunkIndex >= 0 ? rows[i].chunkIndex : undefined);
		}
	}

	private renderVerticalRows(
		beforeBody: HTMLElement,
		afterBody: HTMLElement,
		row: DiffRow,
		chunkIndex: number | undefined,
		collapsible = false
	): void {
		const { before, after } = this.buildVerticalRows(row, chunkIndex, collapsible);
		beforeBody.appendChild(before);
		afterBody.appendChild(after);
	}

	/** Builds the before/after row pair for vertical layout. Native DOM so the
	 * rows can be appended into a tbody or a DocumentFragment (lazy expand). */
	private buildVerticalRows(
		row: DiffRow,
		chunkIndex: number | undefined,
		collapsible: boolean
	): { before: HTMLTableRowElement; after: HTMLTableRowElement } {
		const l = messages();
		const beforeTr = document.createElement("tr");
		beforeTr.className = collapsible
			? `gitee-sync-plus-diff-row gitee-sync-plus-diff-collapsible ${row.oldLine > 0 ? `state-${row.state}` : "state-placeholder"}`
			: `gitee-sync-plus-diff-row ${row.oldLine > 0 ? `state-${row.state}` : "state-placeholder"}`;
		const beforeNum = document.createElement("td");
		beforeNum.className = "gitee-sync-plus-diff-num";
		beforeNum.textContent = row.oldLine > 0 ? String(row.oldLine) : "";
		const beforeCell = document.createElement("td");
		beforeCell.className = "gitee-sync-plus-diff-cell";
		beforeCell.textContent = row.oldLine > 0 ? row.oldText : "";

		const afterTr = document.createElement("tr");
		afterTr.className = collapsible
			? `gitee-sync-plus-diff-row gitee-sync-plus-diff-collapsible ${row.newLine > 0 ? `state-${row.state}` : "state-placeholder"}`
			: `gitee-sync-plus-diff-row ${row.newLine > 0 ? `state-${row.state}` : "state-placeholder"}`;
		const afterNum = document.createElement("td");
		afterNum.className = "gitee-sync-plus-diff-num";
		afterNum.textContent = row.newLine > 0 ? String(row.newLine) : "";
		const afterCell = document.createElement("td");
		afterCell.className = "gitee-sync-plus-diff-cell";
		afterCell.textContent = row.newLine > 0 ? row.newText : "";

		beforeTr.append(beforeNum, beforeCell);
		afterTr.append(afterNum, afterCell);

		if (chunkIndex !== undefined) {
			const attach = (numCell: HTMLElement) => {
				const revertBtn = document.createElement("button");
				revertBtn.textContent = "↩";
				revertBtn.title = l.diffRevertChunk;
				revertBtn.className = "gitee-sync-plus-diff-revert-btn";
				revertBtn.addEventListener("click", (evt) => {
					evt.stopPropagation();
					void this.onRevertChunk(chunkIndex);
				});
				numCell.appendChild(revertBtn);
			};
			if (row.oldLine > 0) attach(beforeNum);
			if (row.newLine > 0) attach(afterNum);
		}
		return { before: beforeTr, after: afterTr };
	}

	private buildRowSegments(rows: DiffRow[]): Array<{ type: "equal" | "diff"; start: number; end: number }> {
		const segments: Array<{ type: "equal" | "diff"; start: number; end: number }> = [];
		let i = 0;
		while (i < rows.length) {
			const start = i;
			const state = rows[i].state;
			if (state === "equal") {
				while (i < rows.length && rows[i].state === "equal") i++;
				segments.push({ type: "equal", start, end: i - 1 });
			} else {
				while (i < rows.length && rows[i].state !== "equal") i++;
				segments.push({ type: "diff", start, end: i - 1 });
			}
		}
		return segments;
	}

	private isFirstRowOfChunk(row: DiffRow, rows: DiffRow[]): boolean {
		const idx = rows.indexOf(row);
		return idx === 0 || rows[idx - 1].chunkIndex !== row.chunkIndex;
	}

	private async onRevertChunk(chunkIndex: number): Promise<void> {
		if (!this.viewState) return;
		const l = messages();
		new RevertConfirmModal(this.app, l.diffRevertChunkConfirm(this.viewState.path), () =>
			void this.revertChunk(chunkIndex)
		).open();
	}

	private async revertChunk(chunkIndex: number): Promise<void> {
		if (!this.viewState || !this.diffContentEl) return;
		const { path, kind } = this.viewState;
		const l = messages();
		this.diffContentEl.setText(l.diffLoading);

		try {
			// Use the prebuilt chunk index instead of a full O(rows) scan.
			const chunkRows = this.chunkRowsIndex.get(chunkIndex) ?? [];
			if (chunkRows.length === 0) return;

			const newText = this.buildTextWithChunkReverted(kind, chunkRows);
			await this.writeLocalText(path, newText);
			new Notice(l.diffReverted);
			void this.loadDiff();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error("[gitee-sync-plus] revert chunk failed", e);
			new Notice(l.diffRevertFailed(msg));
		}
	}

	private buildTextWithChunkReverted(kind: DiffKind, chunkRows: DiffRow[]): string {
		const localIsAfter = kind.startsWith("local");
		const targetLines = splitLines(localIsAfter ? this.currentAfterText : this.currentBeforeText);
		const sourceLines = splitLines(localIsAfter ? this.currentBeforeText : this.currentAfterText);

		const first = chunkRows[0];
		const last = chunkRows[chunkRows.length - 1];

		const targetStartLine = localIsAfter ? first.newLine : first.oldLine;
		const targetEndLine = localIsAfter ? last.newLine : last.oldLine;
		const sourceStartLine = localIsAfter ? first.oldLine : first.newLine;
		const sourceEndLine = localIsAfter ? last.oldLine : last.newLine;

		const targetStartIdx = targetStartLine > 0 ? targetStartLine - 1 : -1;
		const targetEndIdx = targetEndLine > 0 ? targetEndLine - 1 : -1;
		const sourceStartIdx = sourceStartLine > 0 ? sourceStartLine - 1 : -1;
		const sourceEndIdx = sourceEndLine > 0 ? sourceEndLine - 1 : -1;

		let newLines: string[];
		if (targetStartIdx === -1 && targetLines.length === 0) {
			// The whole local file is empty/deleted; restore from the source chunk.
			newLines =
				sourceStartIdx === -1
					? []
					: sourceLines.slice(sourceStartIdx, sourceEndIdx + 1);
		} else {
			const beforeChunk = targetStartIdx >= 0 ? targetLines.slice(0, targetStartIdx) : [];
			const replacement =
				sourceStartIdx === -1 ? [] : sourceLines.slice(sourceStartIdx, sourceEndIdx + 1);
			const afterChunk =
				targetEndIdx >= 0 ? targetLines.slice(targetEndIdx + 1) : targetLines.slice();
			newLines = beforeChunk.concat(replacement).concat(afterChunk);
		}

		return newLines.join("\n");
	}

	private async writeLocalText(path: string, text: string): Promise<void> {
		const encoder = new TextEncoder();
		await this.app.vault.adapter.writeBinary(path, encoder.encode(text).buffer);
	}

	/** Rebuilds the chunkIndex → rows map so reverting a chunk is O(1). */
	private rebuildChunkIndex(rows: DiffRow[]): void {
		this.chunkRowsIndex.clear();
		for (const row of rows) {
			if (row.chunkIndex < 0) continue;
			const list = this.chunkRowsIndex.get(row.chunkIndex);
			if (list) list.push(row);
			else this.chunkRowsIndex.set(row.chunkIndex, [row]);
		}
	}

	/** Renders segments one at a time, yielding to the browser between frames
	 * so the main thread stays responsive on very large diffs. A stale `token`
	 * (from a newer render or view switch) aborts the work cleanly. */
	private renderSegmentsBatched(
		token: number,
		segments: Array<{ type: "equal" | "diff"; start: number; end: number }>,
		render: (seg: { type: "equal" | "diff"; start: number; end: number }) => void
	): Promise<void> {
		return new Promise((resolve) => {
			let idx = 0;
			const step = () => {
				if (token !== this.renderToken) {
					resolve();
					return;
				}
				const start = performance.now();
				while (idx < segments.length) {
					render(segments[idx++]);
					// Stop the frame once the budget is used; resume next tick.
					if (performance.now() - start > FRAME_BUDGET_MS) break;
				}
				if (idx < segments.length) requestAnimationFrame(step);
				else resolve();
			};
			requestAnimationFrame(step);
		});
	}
}

/** Simple confirm modal for reverting a diff chunk. */
class RevertConfirmModal extends Modal {
	private readonly message: string;
	private readonly onConfirm: () => void;

	constructor(app: App, message: string, onConfirm: () => void) {
		super(app);
		this.message = message;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("p", { text: this.message });

		const buttons = contentEl.createDiv({ cls: "gitee-sync-plus-modal-buttons" });

		buttons
			.createEl("button", { text: messages().cancel, cls: "mod-cta" })
			.addEventListener("click", () => this.close());
		buttons
			.createEl("button", { text: messages().diffRevertChunk, cls: "mod-warning" })
			.addEventListener("click", () => {
				this.close();
				this.onConfirm();
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function splitLines(text: string): string[] {
	if (text === "") return [];
	// Keep line endings out of the diff display.
	return text.split(/\r?\n/);
}

/** Replaces CRLF with LF so two textually identical files compare equal. */
function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, "\n");
}

/**
 * Greedy line-based diff that aligns equal lines and emits paired change blocks.
 * Performs well on typical note-sized files while remaining dependency-free.
 */
function computeDiffRows(oldLines: string[], newLines: string[]): DiffRow[] {
	const rows: DiffRow[] = [];
	let i = 0;
	let j = 0;
	let oldLine = 1;
	let newLine = 1;
	let chunkIndex = -1;
	let currentChunk = -1;

	const flushChunk = () => {
		currentChunk = -1;
	};

	const pushRow = (row: DiffRow) => {
		if (row.state !== "equal") {
			if (currentChunk === -1) {
				chunkIndex++;
				currentChunk = chunkIndex;
			}
			row.chunkIndex = currentChunk;
		} else {
			flushChunk();
			row.chunkIndex = -1;
		}
		rows.push(row);
	};

	// Build indexes of lines in BOTH files for O(1) look-ahead matching.
	// Indexing the old side (not just the new side) is the key fix: the
	// previous implementation re-scanned the entire old file for every row,
	// making the diff O(N²) — on a 10k-line file that meant ~100M string
	// comparisons. With both sides indexed the scan drops to O(N + matches).
	const newIndex = new Map<string, number[]>();
	for (let idx = 0; idx < newLines.length; idx++) {
		const line = newLines[idx];
		const list = newIndex.get(line);
		if (list) list.push(idx);
		else newIndex.set(line, [idx]);
	}
	const oldIndex = new Map<string, number[]>();
	for (let idx = 0; idx < oldLines.length; idx++) {
		const line = oldLines[idx];
		const list = oldIndex.get(line);
		if (list) list.push(idx);
		else oldIndex.set(line, [idx]);
	}

	while (i < oldLines.length || j < newLines.length) {
		if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
			pushRow({
				oldLine,
				newLine,
				oldText: oldLines[i],
				newText: newLines[j],
				state: "equal",
				chunkIndex: -1,
			});
			i++;
			j++;
			oldLine++;
			newLine++;
			continue;
		}

		// Find the next matching line in newLines at or after j.
		const candidates = newIndex.get(oldLines[i]);
		let nextMatchNew = -1;
		if (candidates) {
			for (const idx of candidates) {
				if (idx >= j) {
					nextMatchNew = idx;
					break;
				}
			}
		}

		// Find the next matching line in oldLines at or after i — O(1) via index.
		let nextMatchOld = -1;
		if (j < newLines.length) {
			const oldCandidates = oldIndex.get(newLines[j]);
			if (oldCandidates) {
				for (const idx of oldCandidates) {
					if (idx >= i) {
						nextMatchOld = idx;
						break;
					}
				}
			}
		}

		// Decide whether to consume deletions, insertions, or a change block.
		if (nextMatchNew === -1 && nextMatchOld === -1) {
			// No more equal lines: consume the rest as paired changes.
			const oldChunk = oldLines.slice(i);
			const newChunk = newLines.slice(j);
			pushChangeBlock(rows, oldChunk, newChunk, oldLine, newLine, pushRow);
			break;
		}

		if (nextMatchNew !== -1 && (nextMatchOld === -1 || nextMatchNew - j <= nextMatchOld - i)) {
			// New lines were inserted before matching old line i.
			const inserted = newLines.slice(j, nextMatchNew);
			for (const line of inserted) {
				pushRow({ oldLine: 0, newLine, oldText: "", newText: line, state: "insert", chunkIndex: -1 });
				newLine++;
			}
			j = nextMatchNew;
		} else {
			// Old lines were deleted before matching new line j.
			const deleted = oldLines.slice(i, nextMatchOld);
			for (const line of deleted) {
				pushRow({ oldLine, newLine: 0, oldText: line, newText: "", state: "delete", chunkIndex: -1 });
				oldLine++;
			}
			i = nextMatchOld;
		}
	}

	flushChunk();
	return rows;
}

function pushChangeBlock(
	rows: DiffRow[],
	oldChunk: string[],
	newChunk: string[],
	oldStart: number,
	newStart: number,
	pushRow: (row: DiffRow) => void
): void {
	const len = Math.max(oldChunk.length, newChunk.length);
	for (let k = 0; k < len; k++) {
		const oldText = oldChunk[k] ?? "";
		const newText = newChunk[k] ?? "";
		pushRow({
			oldLine: k < oldChunk.length ? oldStart + k : 0,
			newLine: k < newChunk.length ? newStart + k : 0,
			oldText,
			newText,
			state: oldText === newText ? "equal" : "change",
			chunkIndex: -1,
		});
	}
}

/** Opens a diff view for the given path and change kind. */
export async function openDiffView(
	plugin: CloudSyncPlugin,
	path: string,
	kind: DiffKind
): Promise<void> {
	const { workspace } = plugin.app;
	const leaf = workspace.getLeaf("tab");
	await leaf.setViewState({
		type: DIFF_VIEW_TYPE,
		active: true,
		state: { path, kind },
	});
	workspace.revealLeaf(leaf);
}
