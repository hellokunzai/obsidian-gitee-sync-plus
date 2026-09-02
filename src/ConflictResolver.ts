import { App, Modal, Notice } from "obsidian";
import type CloudSyncPlugin from "./main";
import { createBackend } from "./backend";
import { messages } from "./i18n";
import {
	computeDiffRows,
	splitLines,
	type DiffRow,
} from "./DiffView";
import type { ConflictEntry, ConflictResolution } from "./sync";

/** Extract the file name from a vault-relative path for compact display. */
function fileBasename(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const parts = normalized.split("/");
	return parts[parts.length - 1] || path;
}

/** Decode UTF-8 text, rejecting binary content. */
function decodeText(data: ArrayBuffer): string {
	const sample = new Uint8Array(data.slice(0, 1024));
	for (let i = 0; i < sample.length; i++) {
		if (sample[i] === 0) throw new Error(messages().diffBinaryFile);
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(data);
}

/**
 * Modal that lets the user resolve every conflicting file before a pull runs.
 * Each conflict can be resolved by keeping the local copy, overwriting with the
 * remote copy, or opening the merge editor. The collected resolutions are handed
 * back to the caller, which then runs the pull with them applied.
 */
export class ConflictResolverModal extends Modal {
	private readonly resolutions = new Map<string, ConflictResolution>();
	private readonly itemEls = new Map<string, { status: HTMLElement }>();
	private resolved = false;

	constructor(
		app: App,
		private readonly plugin: CloudSyncPlugin,
		private readonly conflicts: ConflictEntry[],
		private readonly onResolve: (resolutions: Map<string, ConflictResolution>) => void,
		private readonly onCancel: () => void
	) {
		super(app);
	}

	onOpen(): void {
		const l = messages();
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("gitee-sync-plus-conflict-modal");

		contentEl.createEl("h3", { text: l.conflictTitle });
		contentEl.createEl("p", {
			text: l.conflictIntro(this.conflicts.length),
			cls: "gitee-sync-plus-conflict-intro",
		});

		const list = contentEl.createDiv("gitee-sync-plus-conflict-list");
		for (const c of this.conflicts) {
			this.renderItem(list, c);
		}

		this.renderFooter();
	}

	private renderItem(parent: HTMLElement, c: ConflictEntry): void {
		const l = messages();
		const card = parent.createDiv("gitee-sync-plus-conflict-item");
		card.title = c.path; // tooltip on hover shows full path

		// Status icon dot
		const status = card.createSpan("gitee-sync-plus-conflict-item-status s-pending");
		status.setText("\u25CF"); /* ● */

		// Filename (bold)
		card.createSpan({
			text: fileBasename(c.path),
			cls: "gitee-sync-plus-conflict-item-name",
		});

		// Filepath (muted)
		card.createSpan({
			text: c.path,
			cls: "gitee-sync-plus-conflict-item-path",
		});

		// Double-click opens diff view
		card.addEventListener("dblclick", () => {
			new ConflictDiffModal(this.app, this.plugin, c, (res) => {
				this.resolve(c.path, res);
				new Notice(
					res.action === "local"
						? l.conflictResolvedLocal
						: res.action === "remote"
							? l.conflictResolvedRemote
							: l.conflictResolvedMerge
				);
			}).open();
		});

		this.itemEls.set(c.path, { status });
	}

	private openMerge(c: ConflictEntry): void {
		const l = messages();
		new MergeEditorModal(this.app, this.plugin, c, (content) => {
			this.resolve(c.path, { action: "merge", content });
			new Notice(l.conflictResolvedMerge);
		}).open();
	}

	private resolve(path: string, resolution: ConflictResolution): void {
		this.resolutions.set(path, resolution);
		this.updateItem(path);
		this.updateFooter();
	}

	private updateItem(path: string): void {
		const el = this.itemEls.get(path);
		if (!el) return;
		const l = messages();
		const res = this.resolutions.get(path);
		let icon = "\u25CF"; /* ● */
		let key: "local" | "remote" | "merge" | "pending" = "pending";
		if (res?.action === "local") {
			icon = "\u2713"; /* ✓ */
			key = "local";
		} else if (res?.action === "remote") {
			icon = "\u2713"; /* ✓ */
			key = "remote";
		} else if (res?.action === "merge") {
			icon = "\u25C6"; /* ◆ */
			key = "merge";
		}
		el.status.setText(icon);
		el.status.className = `gitee-sync-plus-conflict-item-status s-${key}`;
	}

	private renderFooter(): void {
		const l = messages();
		const footer = this.contentEl.createDiv("gitee-sync-plus-conflict-footer");
		const left = footer.createDiv("gitee-sync-plus-conflict-footer-left");
		const useRemoteAll = left.createEl("button", {
			text: l.conflictUseRemoteAll,
			cls: "gitee-sync-plus-conflict-btn",
		});
		const keepLocalAll = left.createEl("button", {
			text: l.conflictUseLocalAll,
			cls: "gitee-sync-plus-conflict-btn",
		});
		useRemoteAll.addEventListener("click", () => {
			for (const c of this.conflicts) this.resolve(c.path, { action: "remote" });
		});
		keepLocalAll.addEventListener("click", () => {
			for (const c of this.conflicts) this.resolve(c.path, { action: "local" });
		});

		const right = footer.createDiv("gitee-sync-plus-conflict-footer-right");
		this.pendingEl = right.createSpan({
			cls: "gitee-sync-plus-conflict-pending",
		});
		const cancel = right.createEl("button", {
			text: l.cancel,
			cls: "mod-cancel",
		});
		cancel.addEventListener("click", () => this.close());
		this.confirmBtn = right.createEl("button", {
			text: l.conflictConfirmPull,
			cls: "mod-cta",
		});
		this.confirmBtn.addEventListener("click", () => this.confirm());
		this.updateFooter();
	}

	private pendingEl!: HTMLElement;
	private confirmBtn!: HTMLButtonElement;

	private updateFooter(): void {
		if (!this.pendingEl) return;
		const l = messages();
		const done = this.resolutions.size;
		const total = this.conflicts.length;
		this.pendingEl.setText(l.conflictPending(done, total));
		const allResolved = done >= total;
		this.confirmBtn.disabled = !allResolved;
		this.confirmBtn.toggleClass("is-disabled", !allResolved);
	}

	private confirm(): void {
		if (this.resolutions.size < this.conflicts.length) return;
		this.resolved = true;
		this.close();
		this.onResolve(this.resolutions);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.resolved) this.onCancel();
	}
}

interface MergeChunk {
	index: number;
	localLines: string[];
	remoteLines: string[];
	choice: "local" | "remote" | "both";
}
interface MergeBlock {
	type: "equal" | "chunk";
	lines?: string[];
	chunk?: MergeChunk;
}

/**
 * Splits a line diff into an ordered list of equal / conflicting blocks. Each
 * conflicting block (a contiguous diff chunk) exposes the local and remote
 * versions so the user can pick one side or keep both.
 */
function buildMergeBlocks(rows: DiffRow[]): MergeBlock[] {
	const blocks: MergeBlock[] = [];
	let i = 0;
	while (i < rows.length) {
		if (rows[i].state === "equal") {
			const lines: string[] = [];
			while (i < rows.length && rows[i].state === "equal") {
				lines.push(rows[i].oldText);
				i++;
			}
			if (lines.length > 0) blocks.push({ type: "equal", lines });
		} else {
			const chunkIndex = rows[i].chunkIndex;
			const localLines: string[] = [];
			const remoteLines: string[] = [];
			while (i < rows.length && rows[i].chunkIndex === chunkIndex) {
				const r = rows[i];
				if (r.oldLine > 0) localLines.push(r.oldText);
				if (r.newLine > 0) remoteLines.push(r.newText);
				i++;
			}
			blocks.push({
				type: "chunk",
				chunk: { index: chunkIndex, localLines, remoteLines, choice: "local" },
			});
		}
	}
	return blocks;
}

/**
 * Editor for manually merging a conflicting file. Shows each conflicting block
 * side by side (local vs remote) with three choices, and assembles an editable
 * merged result that reflects the current choices.
 */
class MergeEditorModal extends Modal {
	private bodyEl!: HTMLElement;
	private resultEl!: HTMLTextAreaElement;
	private blocks: MergeBlock[] = [];

	constructor(
		app: App,
		private readonly plugin: CloudSyncPlugin,
		private readonly entry: ConflictEntry,
		private readonly onMerged: (content: string) => void
	) {
		super(app);
	}

	onOpen(): void {
		const l = messages();
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("gitee-sync-plus-merge-modal");

		const header = contentEl.createDiv("gitee-sync-plus-merge-header");
		header.createSpan({
			text: `${l.mergeTitle} — ${fileBasename(this.entry.path)}`,
			cls: "gitee-sync-plus-merge-title",
		});
		const back = header.createEl("button", {
			text: l.mergeBack,
			cls: "gitee-sync-plus-merge-back",
		});
		back.addEventListener("click", () => this.close());

		contentEl.createEl("p", {
			text: l.mergeHint,
			cls: "gitee-sync-plus-merge-hint",
		});

		this.bodyEl = contentEl.createDiv("gitee-sync-plus-merge-body");
		this.bodyEl.createEl("p", { text: l.diffLoading });

		void this.loadAndRender();
	}

	private async loadAndRender(): Promise<void> {
		const l = messages();
		try {
			const { localText, remoteText } = await this.loadContent();
			this.bodyEl.empty();
			const localLines = splitLines(localText);
			const remoteLines = splitLines(remoteText);
			const rows = computeDiffRows(localLines, remoteLines);
			this.blocks = buildMergeBlocks(rows);

			let chunkSeq = 0;
			for (const b of this.blocks) {
				if (b.type === "equal") {
					this.bodyEl.createDiv({
						text: l.diffUnchangedLines(b.lines!.length),
						cls: "gitee-sync-plus-merge-equal",
					});
				} else {
					chunkSeq++;
					this.renderChunk(b.chunk!, chunkSeq);
				}
			}

			this.bodyEl.createEl("label", {
				text: l.mergeResult,
				cls: "gitee-sync-plus-merge-result-label",
			});
			this.resultEl = this.bodyEl.createEl("textarea", {
				cls: "gitee-sync-plus-merge-result",
			});
			this.updateResult();

			const footer = this.bodyEl.createDiv("gitee-sync-plus-merge-footer");
			const cancel = footer.createEl("button", {
				text: l.mergeCancel,
				cls: "mod-cancel",
			});
			cancel.addEventListener("click", () => this.close());
			const save = footer.createEl("button", {
				text: l.mergeSave,
				cls: "mod-cta",
			});
			save.addEventListener("click", () => {
				this.onMerged(this.resultEl.value);
				this.close();
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.bodyEl.empty();
			this.bodyEl.createEl("p", {
				text: l.diffError(msg),
				cls: "gitee-sync-plus-diff-error",
			});
		}
	}

	private async loadContent(): Promise<{ localText: string; remoteText: string }> {
		const adapter = this.plugin.app.vault.adapter;
		let localText = "";
		if (this.entry.loc && (await adapter.exists(this.entry.path))) {
			const data = await adapter.readBinary(this.entry.path);
			localText = decodeText(data);
		}
		let remoteText = "";
		if (this.entry.rem) {
			const backend = createBackend(this.plugin.settings);
			const { data } = await backend.download(this.entry.path);
			remoteText = decodeText(data);
		}
		return { localText, remoteText };
	}

	private renderChunk(chunk: MergeChunk, seq: number): void {
		const l = messages();
		const card = this.bodyEl.createDiv("gitee-sync-plus-merge-chunk");
		card.createDiv({
			text: l.mergeChunk(seq),
			cls: "gitee-sync-plus-merge-chunk-label",
		});

		const sides = card.createDiv("gitee-sync-plus-merge-chunk-sides");
		const localBox = sides.createDiv(
			"gitee-sync-plus-merge-side gitee-sync-plus-merge-side-local"
		);
		localBox.createDiv({
			text: l.mergeLocalVersion,
			cls: "gitee-sync-plus-merge-side-title",
		});
		localBox.createEl("pre", {
			text: chunk.localLines.join("\n") || "（空）",
			cls: "gitee-sync-plus-merge-side-pre",
		});
		const remoteBox = sides.createDiv(
			"gitee-sync-plus-merge-side gitee-sync-plus-merge-side-remote"
		);
		remoteBox.createDiv({
			text: l.mergeRemoteVersion,
			cls: "gitee-sync-plus-merge-side-title",
		});
		remoteBox.createEl("pre", {
			text: chunk.remoteLines.join("\n") || "（空）",
			cls: "gitee-sync-plus-merge-side-pre",
		});

		const btns = card.createDiv("gitee-sync-plus-merge-chunk-btns");
		const useLocal = btns.createEl("button", {
			text: l.mergeUseLocal,
			cls: "gitee-sync-plus-merge-choice",
		});
		const useRemote = btns.createEl("button", {
			text: l.mergeUseRemote,
			cls: "gitee-sync-plus-merge-choice",
		});
		const keepBoth = btns.createEl("button", {
			text: l.mergeBoth,
			cls: "gitee-sync-plus-merge-choice",
		});

		const setChoice = (choice: "local" | "remote" | "both") => {
			chunk.choice = choice;
			useLocal.toggleClass("is-selected", choice === "local");
			useRemote.toggleClass("is-selected", choice === "remote");
			keepBoth.toggleClass("is-selected", choice === "both");
			this.updateResult();
		};
		useLocal.addEventListener("click", () => setChoice("local"));
		useRemote.addEventListener("click", () => setChoice("remote"));
		keepBoth.addEventListener("click", () => setChoice("both"));
		setChoice(chunk.choice);
	}

	private assemble(): string {
		const out: string[] = [];
		for (const b of this.blocks) {
			if (b.type === "equal") {
				out.push(...(b.lines ?? []));
			} else if (b.chunk) {
				if (b.chunk.choice === "local") out.push(...b.chunk.localLines);
				else if (b.chunk.choice === "remote") out.push(...b.chunk.remoteLines);
				else out.push(...b.chunk.localLines, ...b.chunk.remoteLines);
			}
		}
		return out.join("\n");
	}

	private updateResult(): void {
		if (this.resultEl) this.resultEl.value = this.assemble();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * In-modal diff viewer for a conflicting file. Opens on top of the conflict
 * resolver so the user can compare local vs remote without the side-effect of
 * opening a (blocked) workspace tab. Supports side-by-side / vertical layouts,
 * collapse of unchanged runs, and one-click "keep local" / "use remote" which
 * resolve that conflict and return to the resolver.
 */
export class ConflictDiffModal extends Modal {
	private bodyEl!: HTMLElement;
	private statEl!: HTMLElement;
	private layoutBtn!: HTMLButtonElement;
	private collapseBtn!: HTMLButtonElement;
	private applyMergeBtn!: HTMLButtonElement;
	private layout: "side-by-side" | "vertical" = "side-by-side";
	private collapseUnchanged = true;
	private rows: DiffRow[] = [];
	/** Per-row resolution for the line-level merge. Keyed by DiffRow index.
	 *  A row not present here falls back to `entry.preferred`. */
	private lineChoices = new Map<number, "local" | "remote">();
	/** Line ending used when reassembling merged content (preserves CRLF files). */
	private eol = "\n";
	private loaded = false;
	private readonly contextLines = 2;
	/** Aborts listeners attached by the drag-to-scroll helper so re-renders
	 * (layout toggle / collapse) don't leak window-level mouse handlers. */
	private dragAbort?: AbortController;

	constructor(
		app: App,
		private readonly plugin: CloudSyncPlugin,
		private readonly entry: ConflictEntry,
		private readonly onResolve: (resolution: ConflictResolution) => void
	) {
		super(app);
	}

	onOpen(): void {
		const l = messages();
		const { contentEl, modalEl } = this;
		contentEl.empty();
		contentEl.addClass("gitee-sync-plus-conflict-diff-modal");
		// Make the modal fill the viewport so the diff body can scroll.
		modalEl.style.width = "min(1100px, 94vw)";
		contentEl.style.height = "82vh";
		contentEl.style.display = "flex";
		contentEl.style.flexDirection = "column";

		const header = contentEl.createDiv("gitee-sync-plus-conflict-diff-header");
		const back = header.createEl("button", {
			cls: "gitee-sync-plus-conflict-diff-btn gitee-sync-plus-conflict-diff-back",
		});
		back.setText("← " + l.conflictDiffBack);
		back.addEventListener("click", () => this.close());
		header.createSpan({
			text: `${l.conflictDiffTitle} — ${fileBasename(this.entry.path)}`,
			cls: "gitee-sync-plus-conflict-diff-title",
		});
		const actions = header.createDiv("gitee-sync-plus-conflict-diff-actions");
		this.layoutBtn = actions.createEl("button", {
			cls: "gitee-sync-plus-conflict-diff-btn gitee-sync-plus-conflict-diff-icon-btn",
			title: l.diffLayoutToggle,
		});
		this.layoutBtn.addEventListener("click", () => {
			this.layout = this.layout === "side-by-side" ? "vertical" : "side-by-side";
			this.updateLayoutButton();
			this.render();
		});
		this.collapseBtn = actions.createEl("button", {
			cls: "gitee-sync-plus-conflict-diff-btn gitee-sync-plus-conflict-diff-icon-btn",
			title: l.diffCollapseUnchanged,
		});
		this.collapseBtn.addEventListener("click", () => {
			this.collapseUnchanged = !this.collapseUnchanged;
			this.updateCollapseButton();
			this.render();
		});

		this.bodyEl = contentEl.createDiv("gitee-sync-plus-conflict-diff-body");
		this.bodyEl.createEl("p", { text: l.diffLoading });

		const footer = contentEl.createDiv("gitee-sync-plus-conflict-diff-footer");
		this.statEl = footer.createSpan({ cls: "gitee-sync-plus-conflict-diff-stat" });
		const right = footer.createDiv("gitee-sync-plus-conflict-diff-footer-right");
		const keepLocal = right.createEl("button", {
			text: l.conflictUseLocal,
			cls: "gitee-sync-plus-conflict-btn gitee-sync-plus-conflict-btn-local",
		});
		keepLocal.addEventListener("click", () => {
			this.setAllChoices("local");
		});
		const useRemote = right.createEl("button", {
			text: l.conflictUseRemote,
			cls: "gitee-sync-plus-conflict-btn gitee-sync-plus-conflict-btn-remote",
		});
		useRemote.addEventListener("click", () => {
			this.setAllChoices("remote");
		});
		const applyMerge = right.createEl("button", {
			text: l.conflictApplyMerge,
			cls: "gitee-sync-plus-conflict-btn gitee-sync-plus-conflict-btn-merge mod-cta",
		});
		applyMerge.addEventListener("click", () => {
			this.applyMerge();
		});
		this.applyMergeBtn = applyMerge;
		this.updateApplyMergeBtn();

		this.updateLayoutButton();
		this.updateCollapseButton();
		void this.loadAndRender();
	}

	private updateLayoutButton(): void {
		this.layoutBtn.innerHTML =
			this.layout === "side-by-side"
				? "\u21C5" /* ⇅ */
				: "\u21C4" /* ⇄ */;
	}

	private updateCollapseButton(): void {
		// Match the tab view (DiffView.ts): use ≣ / ≡ instead of ▼ / ▶.
		this.collapseBtn.innerHTML = this.collapseUnchanged
			? "\u2263" /* ≣ */
			: "\u2261" /* ≡ */;
		this.collapseBtn.toggleClass("is-active", this.collapseUnchanged);
	}

	/** Update a per-row choice from a checkbox change event. */
	private onCheckboxChange(index: number, side: "local" | "remote", checked: boolean): void {
		if (checked) this.lineChoices.set(index, side);
		else if (this.lineChoices.get(index) === side) this.lineChoices.delete(index);
		this.render();
	}

	/** Count conflicting rows (those that need an explicit choice). */
	private conflictRowCount(): number {
		let total = 0;
		for (const r of this.rows) if (r.state !== "equal") total++;
		return total;
	}

	/** Number of conflicting rows that have been explicitly picked. */
	private pickedRowCount(): number {
		let picked = 0;
		for (let i = 0; i < this.rows.length; i++) {
			if (this.rows[i].state !== "equal" && this.lineChoices.has(i)) picked++;
		}
		return picked;
	}

	/** Batch-set every conflicting row to the given side. Mirrors the per-row
	 * accept buttons but applies to the whole file at once; the merge is only
	 * finalized when the user clicks "Apply merge". */
	private setAllChoices(side: "local" | "remote"): void {
		for (let i = 0; i < this.rows.length; i++) {
			if (this.rows[i].state !== "equal") this.lineChoices.set(i, side);
		}
		this.render();
	}

	/** Apply the merge only after every conflicting row is resolved. */
	private applyMerge(): void {
		const total = this.conflictRowCount();
		if (total === 0 || this.pickedRowCount() < total) return;
		this.onResolve({ action: "merge", content: this.assembleMerge() });
		this.close();
	}

	/** Enable "Apply merge" only after every conflicting row is explicitly
	 * picked. The label stays constant; the remaining-row count is reported by
	 * the footer status line instead of bloating the button. */
	private updateApplyMergeBtn(): void {
		if (!this.applyMergeBtn) return;
		const l = messages();
		const total = this.conflictRowCount();
		const unresolved = total - this.pickedRowCount();
		const ready = total > 0 && unresolved === 0;
		this.applyMergeBtn.disabled = !ready;
		this.applyMergeBtn.toggleClass("is-disabled", !ready);
		this.applyMergeBtn.setText(l.conflictApplyMerge);
	}

	/** Build the merged file content from per-row choices. Untouched rows fall
	 *  back to `entry.preferred`; equal rows always keep their text. A choice
	 *  pointing at an empty side (e.g. accept-local on an insert) drops the row. */
	private assembleMerge(): string {
		const out: string[] = [];
		for (let i = 0; i < this.rows.length; i++) {
			const r = this.rows[i];
			if (r.state === "equal") {
				out.push(r.oldText);
				continue;
			}
			const side = this.lineChoices.get(i) ?? this.entry.preferred;
			if (side === "local") {
				if (r.oldLine > 0) out.push(r.oldText);
			} else {
				if (r.newLine > 0) out.push(r.newText);
			}
		}
		return out.join(this.eol);
	}

	/** Infer the dominant line ending so merged output matches the source file. */
	private detectEol(sample: string): string {
		if (!sample) return "\n";
		const crlf = (sample.match(/\r\n/g) ?? []).length;
		const lf = (sample.replace(/\r\n/g, "").match(/\n/g) ?? []).length;
		return crlf > 0 && crlf >= lf ? "\r\n" : "\n";
	}

	private async loadAndRender(): Promise<void> {
		const l = messages();
		try {
			const { local, remote } = await this.loadText();
			this.eol = this.detectEol(local || remote);
		const localLines = splitLines(local);
			const remoteLines = splitLines(remote);
			this.rows = computeDiffRows(localLines, remoteLines);
			this.loaded = true;
			this.render();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.bodyEl.empty();
			this.bodyEl.createEl("p", {
				text: l.diffError(msg),
				cls: "gitee-sync-plus-diff-error",
			});
		}
	}

	private async loadText(): Promise<{ local: string; remote: string }> {
		const adapter = this.plugin.app.vault.adapter;
		let local = "";
		if (this.entry.loc && (await adapter.exists(this.entry.path))) {
			const data = await adapter.readBinary(this.entry.path);
			local = decodeText(data);
		}
		let remote = "";
		if (this.entry.rem) {
			const backend = createBackend(this.plugin.settings);
			const { data } = await backend.download(this.entry.path);
			remote = decodeText(data);
		}
		return { local, remote };
	}

	private render(): void {
		if (!this.loaded) return;
		const l = messages();
		this.bodyEl.empty();
		// Drop drag-scroll listeners from the previous render before the
		// scroll containers are recreated.
		this.dragAbort?.abort();
		this.dragAbort = new AbortController();
		this.bodyEl.addClass("gitee-sync-plus-diff-content");
		this.bodyEl.removeClass("layout-side-by-side", "layout-vertical");
		this.bodyEl.addClass(this.layout === "side-by-side" ? "layout-side-by-side" : "layout-vertical");
		this.bodyEl.toggleClass("collapse-unchanged", this.collapseUnchanged);

		if (this.layout === "side-by-side") this.renderSideBySide();
		else this.renderVertical();

		this.renderStat();
		this.updateApplyMergeBtn();
	}

	private renderStat(): void {
		const l = messages();
		let del = 0;
		let ins = 0;
		for (const r of this.rows) {
			if (r.state === "delete") del++;
			else if (r.state === "insert") ins++;
			else if (r.state === "change") {
				del++;
				ins++;
			}
		}
		// The "N rows unresolved" hint used to live on the "Apply merge"
		// button; it now reads here so the button keeps a short label.
		const unresolved = this.conflictRowCount() - this.pickedRowCount();
		const parts = [l.conflictDiffStats(del, ins)];
		if (unresolved > 0) parts.push(l.conflictDiffRemaining(unresolved));
		const picked = this.lineChoices.size;
		if (picked > 0) parts.push(l.diffAcceptedHint(picked));
		this.statEl.setText(parts.join(" · "));
	}

	private buildSegments(): Array<{ type: "equal" | "diff"; start: number; end: number }> {
		const rows = this.rows;
		const segments: Array<{ type: "equal" | "diff"; start: number; end: number }> = [];
		let i = 0;
		while (i < rows.length) {
			const start = i;
			if (rows[i].state === "equal") {
				while (i < rows.length && rows[i].state === "equal") i++;
				segments.push({ type: "equal", start, end: i - 1 });
			} else {
				while (i < rows.length && rows[i].state !== "equal") i++;
				segments.push({ type: "diff", start, end: i - 1 });
			}
		}
		return segments;
	}

	private renderSideBySide(): void {
		const l = messages();
		const ctx = this.contextLines;
		// Two independent sections (local on the left, remote on the right) so
		// the line-number/checkbox gutter visually belongs to its pane instead
		// of looking like a single shared "center column". Each section has its
		// own scroller, so horizontal drag-to-scroll only pans the pane the
		// pointer started on.
		const wrapper = this.bodyEl.createDiv("gitee-sync-plus-diff-files");

		/* Local pane (left): contains its own line-number + checkbox column. */
		const localSection = wrapper.createDiv(
			"gitee-sync-plus-diff-section gitee-sync-plus-diff-section-local"
		);
		localSection.createDiv("gitee-sync-plus-diff-section-label").setText(l.diffLeftLocal);
		const localScroll = localSection.createDiv("gitee-sync-plus-diff-section-scroll");
		const localTable = localScroll.createEl("table", {
			cls: "gitee-sync-plus-diff-section-table",
		});
		this.attachDragScroll(localScroll);

		/* Remote pane (right): contains its own line-number + checkbox column. */
		const remoteSection = wrapper.createDiv(
			"gitee-sync-plus-diff-section gitee-sync-plus-diff-section-remote"
		);
		remoteSection.createDiv("gitee-sync-plus-diff-section-label").setText(l.diffRightRemote);
		const remoteScroll = remoteSection.createDiv("gitee-sync-plus-diff-section-scroll");
		const remoteTable = remoteScroll.createEl("table", {
			cls: "gitee-sync-plus-diff-section-table",
		});
		this.attachDragScroll(remoteScroll);

		for (const seg of this.buildSegments()) {
			const len = seg.end - seg.start + 1;
			if (seg.type === "diff" || len <= ctx * 2 || !this.collapseUnchanged) {
				const localBody = localTable.createEl("tbody");
				const remoteBody = remoteTable.createEl("tbody");
				for (let i = seg.start; i <= seg.end; i++) {
					// Reuse the row builder: it emits {remoteEl, localEl} with the
					// line-number + checkbox already attached on each side.
					const { remoteEl, localEl } = this.buildVerticalPair(this.rows[i], false, i);
					localBody.appendChild(localEl);
					remoteBody.appendChild(remoteEl);
				}
				continue;
			}
			/* Long equal run: collapse the middle behind a placeholder on both panes.
			   A click on either side expands both, so the rows stay vertically aligned. */
			const localBody = localTable.createEl("tbody", { cls: "gitee-sync-plus-diff-collapsed-body" });
			const remoteBody = remoteTable.createEl("tbody", { cls: "gitee-sync-plus-diff-collapsed-body" });
			for (let i = seg.start; i < seg.start + ctx; i++) {
				const { remoteEl, localEl } = this.buildVerticalPair(this.rows[i], false, i);
				localBody.appendChild(localEl);
				remoteBody.appendChild(remoteEl);
			}
			const hidden = len - ctx * 2;
			const localPh = localBody.createEl("tr", {
				cls: "gitee-sync-plus-diff-row gitee-sync-plus-diff-collapsed-placeholder",
			});
			localPh.createEl("td", { cls: "gitee-sync-plus-diff-num" }).setText("\u22EF"); /* ⋯ */
			localPh.createEl("td", { cls: "gitee-sync-plus-diff-cell" });

			const remotePh = remoteBody.createEl("tr", {
				cls: "gitee-sync-plus-diff-row gitee-sync-plus-diff-collapsed-placeholder",
			});
			remotePh.createEl("td", { cls: "gitee-sync-plus-diff-num" }).setText("\u22EF"); /* ⋯ */
			remotePh.createEl("td", { cls: "gitee-sync-plus-diff-cell" }).setText(l.diffUnchangedLines(hidden));

			const fragLocal = document.createDocumentFragment();
			const fragRemote = document.createDocumentFragment();
			for (let i = seg.start + ctx; i <= seg.end - ctx; i++) {
				const { remoteEl, localEl } = this.buildVerticalPair(this.rows[i], true, i);
				fragLocal.appendChild(localEl);
				fragRemote.appendChild(remoteEl);
			}
			localPh.after(fragLocal);
			remotePh.after(fragRemote);

			const expand = () => {
				localBody.toggleClass("is-expanded", true);
				remoteBody.toggleClass("is-expanded", true);
			};
			localPh.addEventListener("click", expand);
			remotePh.addEventListener("click", expand);

			for (let i = seg.end - ctx + 1; i <= seg.end; i++) {
				const { remoteEl, localEl } = this.buildVerticalPair(this.rows[i], false, i);
				localBody.appendChild(localEl);
				remoteBody.appendChild(remoteEl);
			}
		}
	}

	private renderVertical(): void {
		const l = messages();
		const ctx = this.contextLines;
		const wrapper = this.bodyEl.createDiv(
			"gitee-sync-plus-diff-files gitee-sync-plus-diff-files-vertical"
		);

		/* Remote version panel (top) */
		const remoteSection = wrapper.createDiv(
			"gitee-sync-plus-diff-section gitee-sync-plus-diff-section-remote"
		);
		remoteSection.createDiv("gitee-sync-plus-diff-section-label").setText(l.diffRightRemote);
		const remoteScroll = remoteSection.createDiv("gitee-sync-plus-diff-section-scroll");
		const remoteTable = remoteScroll.createEl("table", {
			cls: "gitee-sync-plus-diff-section-table",
		});
		this.attachDragScroll(remoteScroll);

		/* Local version panel (bottom) */
		const localSection = wrapper.createDiv(
			"gitee-sync-plus-diff-section gitee-sync-plus-diff-section-local"
		);
		localSection.createDiv("gitee-sync-plus-diff-section-label").setText(l.diffLeftLocal);
		const localScroll = localSection.createDiv("gitee-sync-plus-diff-section-scroll");
		const localTable = localScroll.createEl("table", {
			cls: "gitee-sync-plus-diff-section-table",
		});
		this.attachDragScroll(localScroll);

		for (const seg of this.buildSegments()) {
			const len = seg.end - seg.start + 1;
			if (seg.type === "diff" || len <= ctx * 2 || !this.collapseUnchanged) {
				const remoteBody = remoteTable.createEl("tbody");
				const localBody = localTable.createEl("tbody");
				for (let i = seg.start; i <= seg.end; i++) {
					this.appendVerticalRows(remoteBody, localBody, this.rows[i], false, i);
				}
				continue;
			}
			/* Long equal run: collapse the middle */
			const remoteBody = remoteTable.createEl("tbody", { cls: "gitee-sync-plus-diff-collapsed-body" });
			const localBody = localTable.createEl("tbody", { cls: "gitee-sync-plus-diff-collapsed-body" });
			for (let i = seg.start; i < seg.start + ctx; i++) {
				this.appendVerticalRows(remoteBody, localBody, this.rows[i], false, i);
			}
			const hidden = len - ctx * 2;
			const remotePh = remoteBody.createEl("tr", {
				cls: "gitee-sync-plus-diff-row gitee-sync-plus-diff-collapsed-placeholder",
			});
			remotePh.createEl("td", { cls: "gitee-sync-plus-diff-num" }).setText("\u22EF"); /* ⋯ */
			remotePh.createEl("td", { cls: "gitee-sync-plus-diff-cell" });
			const localPh = localBody.createEl("tr", {
				cls: "gitee-sync-plus-diff-row gitee-sync-plus-diff-collapsed-placeholder",
			});
			localPh.createEl("td", { cls: "gitee-sync-plus-diff-num" }).setText("\u22EF"); /* ⋯ */
			localPh.createEl("td", { cls: "gitee-sync-plus-diff-cell" }).setText(l.diffUnchangedLines(hidden));

			const fragRemote = document.createDocumentFragment();
			const fragLocal = document.createDocumentFragment();
			for (let i = seg.start + ctx; i <= seg.end - ctx; i++) {
				const { remoteEl, localEl } = this.buildVerticalPair(this.rows[i], true, i);
				fragRemote.appendChild(remoteEl);
				fragLocal.appendChild(localEl);
			}
			remotePh.after(fragRemote);
			localPh.after(fragLocal);

			const expand = () => {
				remoteBody.toggleClass("is-expanded", true);
				localBody.toggleClass("is-expanded", true);
			};
			remotePh.addEventListener("click", expand);
			localPh.addEventListener("click", expand);

			for (let i = seg.end - ctx + 1; i <= seg.end; i++) {
				this.appendVerticalRows(remoteBody, localBody, this.rows[i], false, i);
			}
		}
	}

	private appendVerticalRows(
		remoteBody: HTMLElement,
		localBody: HTMLElement,
		row: DiffRow,
		collapsible: boolean,
		rowIndex: number
	): void {
		const { remoteEl, localEl } = this.buildVerticalPair(row, collapsible, rowIndex);
		remoteBody.appendChild(remoteEl);
		localBody.appendChild(localEl);
	}

	private buildVerticalPair(
		row: DiffRow,
		collapsible: boolean,
		rowIndex: number
	): { remoteEl: HTMLTableRowElement; localEl: HTMLTableRowElement } {
		const l = messages();
		const cls = collapsible ? " gitee-sync-plus-diff-collapsible" : "";
		const choice = this.lineChoices.get(rowIndex);

		/* Remote row (newText / newLine) — top panel */
		const remoteTr = document.createElement("tr");
		remoteTr.className =
			`gitee-sync-plus-diff-row${cls} ${row.newLine > 0 ? `state-${row.state}` : "state-placeholder"}`;
		const remoteNum = document.createElement("td");
		remoteNum.className = "gitee-sync-plus-diff-num";
		const remoteNumText = remoteNum.createEl("span", {
			cls: "gitee-sync-plus-diff-num-text",
		});
		// Fall back to the local line number when the row is missing on the
		// remote side (state "delete"): the cell is empty but the gutter still
		// shows an anchor so the user can see which local row this "accept
		// remote" button belongs to.
		remoteNumText.textContent =
			row.newLine > 0
				? String(row.newLine)
				: row.oldLine > 0
					? String(row.oldLine)
					: "";
		const remoteCell = document.createElement("td");
		remoteCell.className = "gitee-sync-plus-diff-cell" + (row.newLine === 0 ? " gitee-sync-plus-diff-empty" : "");
		const remoteText = document.createElement("span");
		remoteText.className = "gitee-sync-plus-diff-cell-text";
		remoteText.textContent = row.newText;
		remoteCell.appendChild(remoteText);
		remoteTr.append(remoteNum, remoteCell);

		/* Local row (oldText / oldLine) — bottom panel */
		const localTr = document.createElement("tr");
		localTr.className =
			`gitee-sync-plus-diff-row${cls} ${row.oldLine > 0 ? `state-${row.state}` : "state-placeholder"}`;
		const localNum = document.createElement("td");
		localNum.className = "gitee-sync-plus-diff-num";
		const localNumText = localNum.createEl("span", {
			cls: "gitee-sync-plus-diff-num-text",
		});
		// Mirror fallback: an "insert" row (only on the remote side) still
		// shows the remote line number on the local gutter as an anchor.
		localNumText.textContent =
			row.oldLine > 0
				? String(row.oldLine)
				: row.newLine > 0
					? String(row.newLine)
					: "";
		const localCell = document.createElement("td");
		localCell.className = "gitee-sync-plus-diff-cell" + (row.oldLine === 0 ? " gitee-sync-plus-diff-empty" : "");
		const localText = document.createElement("span");
		localText.className = "gitee-sync-plus-diff-cell-text";
		localText.textContent = row.oldText;
		localCell.appendChild(localText);
		localTr.append(localNum, localCell);

		/* One accept button per side, inline in the num cell: the remote button
		   lives on the remote (top) row, the local button on the local (bottom)
		   row. The button is offered even when that side is a placeholder, so
		   "accept local" on a remote insert (= drop it) stays reachable. */
		if (row.state !== "equal") {
			const acceptRemote = remoteNum.createEl("input", {
				type: "checkbox",
				cls: "gitee-sync-plus-diff-accept-checkbox gitee-sync-plus-diff-accept-remote",
				title: l.diffAcceptRemote,
			});
			acceptRemote.checked = choice === "remote";
			acceptRemote.addEventListener("change", (evt) => {
				evt.stopPropagation();
				this.onCheckboxChange(rowIndex, "remote", acceptRemote.checked);
			});
			remoteTr.addClass("has-choice");

			const acceptLocal = localNum.createEl("input", {
				type: "checkbox",
				cls: "gitee-sync-plus-diff-accept-checkbox gitee-sync-plus-diff-accept-local",
				title: l.diffAcceptLocal,
			});
			acceptLocal.checked = choice === "local";
			acceptLocal.addEventListener("change", (evt) => {
				evt.stopPropagation();
				this.onCheckboxChange(rowIndex, "local", acceptLocal.checked);
			});
			localTr.addClass("has-choice");

			/* Visual state: accepted side is highlighted, the other is dimmed. */
			if (choice === "remote") {
				remoteTr.addClass("is-accepted");
				localTr.addClass("is-rejected");
			} else if (choice === "local") {
				localTr.addClass("is-accepted");
				remoteTr.addClass("is-rejected");
			}
		}

		return { remoteEl: remoteTr, localEl: localTr };
	}

	/**
	 * Enables click-and-drag horizontal panning on a diff scroll container
	 * (drag-to-scroll), so a long line that overflows the pane can be revealed
	 * without hunting for the thin scrollbar. Vertical scrolling stays native.
	 * A small movement threshold keeps normal clicks / inline buttons working.
	 * Listeners are tied to this.dragAbort so re-renders don't leak them.
	 */
	private attachDragScroll(scroller: HTMLElement): void {
		if (!this.dragAbort) this.dragAbort = new AbortController();
		const signal = this.dragAbort.signal;
		const DRAG_THRESHOLD = 4;
		let isDown = false;
		let startX = 0;
		let startScrollLeft = 0;
		let hasDragged = false;

		scroller.addEventListener(
			"mousedown",
			(e: MouseEvent) => {
				if (e.button !== 0) return;
				isDown = true;
				hasDragged = false;
				startX = e.clientX;
				startScrollLeft = scroller.scrollLeft;
				scroller.classList.add("is-dragging");
			},
			{ signal }
		);

		window.addEventListener(
			"mousemove",
			(e: MouseEvent) => {
				if (!isDown) return;
				const dx = e.clientX - startX;
				if (Math.abs(dx) > DRAG_THRESHOLD) hasDragged = true;
				scroller.scrollLeft = startScrollLeft - dx;
			},
			{ signal }
		);

		window.addEventListener(
			"mouseup",
			() => {
				if (!isDown) return;
				isDown = false;
				scroller.classList.remove("is-dragging");
			},
			{ signal }
		);

		// Swallow the click that follows a real drag so inline accept buttons
		// aren't activated by the drag's ending position.
		scroller.addEventListener(
			"click",
			(e: MouseEvent) => {
				if (hasDragged) {
					e.stopPropagation();
					e.preventDefault();
					hasDragged = false;
				}
			},
			{ capture: true, signal }
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
