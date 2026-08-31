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
	private readonly itemEls = new Map<
		string,
		{
			status: HTMLElement;
			buttons: {
				local: HTMLElement;
				remote: HTMLElement;
				merge: HTMLElement;
			};
		}
	>();
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
		const head = card.createDiv("gitee-sync-plus-conflict-item-head");
		head.createSpan({
			text: fileBasename(c.path),
			cls: "gitee-sync-plus-conflict-item-name",
		});
		head.createSpan({
			text: c.path,
			cls: "gitee-sync-plus-conflict-item-path",
		});
		card.createEl("p", {
			text: c.reason,
			cls: "gitee-sync-plus-conflict-item-reason",
		});

		const status = card.createDiv("gitee-sync-plus-conflict-item-status s-pending");
		status.setText(l.conflictResolvedPending);

		const actions = card.createDiv("gitee-sync-plus-conflict-item-actions");
		const viewDiff = actions.createEl("button", {
			text: l.conflictViewDiff,
			cls: "gitee-sync-plus-conflict-btn gitee-sync-plus-conflict-btn-view",
		});
		const keepLocal = actions.createEl("button", {
			text: l.conflictUseLocal,
			cls: "gitee-sync-plus-conflict-btn gitee-sync-plus-conflict-btn-local",
		});
		const useRemote = actions.createEl("button", {
			text: l.conflictUseRemote,
			cls: "gitee-sync-plus-conflict-btn gitee-sync-plus-conflict-btn-remote",
		});
		const merge = actions.createEl("button", {
			text: l.conflictMerge,
			cls: "gitee-sync-plus-conflict-btn gitee-sync-plus-conflict-btn-merge",
		});

		viewDiff.addEventListener("click", () => {
			new ConflictDiffModal(this.app, this.plugin, c, (action) => {
				this.resolve(c.path, { action });
				new Notice(action === "local" ? l.conflictResolvedLocal : l.conflictResolvedRemote);
			}).open();
		});
		keepLocal.addEventListener("click", () =>
			this.resolve(c.path, { action: "local" })
		);
		useRemote.addEventListener("click", () =>
			this.resolve(c.path, { action: "remote" })
		);
		merge.addEventListener("click", () => this.openMerge(c));

		this.itemEls.set(c.path, {
			status,
			buttons: { local: keepLocal, remote: useRemote, merge },
		});
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
		let label = l.conflictResolvedPending;
		let key: "local" | "remote" | "merge" | "pending" = "pending";
		if (res?.action === "local") {
			label = l.conflictResolvedLocal;
			key = "local";
		} else if (res?.action === "remote") {
			label = l.conflictResolvedRemote;
			key = "remote";
		} else if (res?.action === "merge") {
			label = l.conflictResolvedMerge;
			key = "merge";
		}
		el.status.setText(label);
		el.status.className = `gitee-sync-plus-conflict-item-status s-${key}`;
		el.buttons.local.toggleClass("is-selected", key === "local");
		el.buttons.remote.toggleClass("is-selected", key === "remote");
		el.buttons.merge.toggleClass("is-selected", key === "merge");
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
 * opening a (blocked) workspace tab. Supports side-by-side / unified layouts,
 * collapse of unchanged runs, and one-click "keep local" / "use remote" which
 * resolve that conflict and return to the resolver.
 */
export class ConflictDiffModal extends Modal {
	private bodyEl!: HTMLElement;
	private statEl!: HTMLElement;
	private layoutBtn!: HTMLButtonElement;
	private collapseBtn!: HTMLButtonElement;
	private layout: "side-by-side" | "unified" = "side-by-side";
	private collapseUnchanged = true;
	private rows: DiffRow[] = [];
	private rolledBack = new Set<number>();
	private loaded = false;
	private readonly contextLines = 2;

	constructor(
		app: App,
		private readonly plugin: CloudSyncPlugin,
		private readonly entry: ConflictEntry,
		private readonly onResolve: (action: "local" | "remote") => void
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
			this.layout = this.layout === "side-by-side" ? "unified" : "side-by-side";
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
			this.onResolve("local");
			this.close();
		});
		const useRemote = right.createEl("button", {
			text: l.conflictUseRemote,
			cls: "gitee-sync-plus-conflict-btn gitee-sync-plus-conflict-btn-remote",
		});
		useRemote.addEventListener("click", () => {
			this.onResolve("remote");
			this.close();
		});

		this.updateLayoutButton();
		this.updateCollapseButton();
		void this.loadAndRender();
	}

	private updateLayoutButton(): void {
		this.layoutBtn.innerHTML =
			this.layout === "side-by-side"
				? "&#x21C5;" /* ⇅ */
				: "&#x2630;" /* ☰ */;
	}

	private updateCollapseButton(): void {
		this.collapseBtn.innerHTML = this.collapseUnchanged
			? "&#x25BC;" /* ▼ */
			: "&#x25B6;" /* ▶ */;
		this.collapseBtn.toggleClass("is-active", this.collapseUnchanged);
	}

	private async loadAndRender(): Promise<void> {
		const l = messages();
		try {
			const { local, remote } = await this.loadText();
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
		this.bodyEl.addClass("gitee-sync-plus-diff-content");
		this.bodyEl.removeClass("layout-side-by-side", "layout-vertical");
		this.bodyEl.addClass(this.layout === "side-by-side" ? "layout-side-by-side" : "layout-vertical");
		this.bodyEl.toggleClass("collapse-unchanged", this.collapseUnchanged);

		if (this.layout === "side-by-side") this.renderSideBySide();
		else this.renderUnified();

		this.renderStat();
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
		this.statEl.setText(l.conflictDiffStats(del, ins));
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
		const wrapper = this.bodyEl.createDiv("gitee-sync-plus-diff-files");
		const section = wrapper.createDiv(
			"gitee-sync-plus-diff-section gitee-sync-plus-diff-section-wide"
		);
		const header = section.createDiv("gitee-sync-plus-diff-section-labels");
		header.createSpan({ cls: "gitee-sync-plus-diff-section-label-left", text: l.diffLeftLocal });
		header.createSpan({ cls: "gitee-sync-plus-diff-section-label-right", text: l.diffRightRemote });
		const scrollBox = section.createDiv("gitee-sync-plus-diff-section-scroll");
		const table = scrollBox.createEl("table", { cls: "gitee-sync-plus-diff-table" });

		for (const seg of this.buildSegments()) {
			const len = seg.end - seg.start + 1;
			if (seg.type === "diff" || len <= ctx * 2 || !this.collapseUnchanged) {
				const tbody = table.createEl("tbody");
				for (let i = seg.start; i <= seg.end; i++) {
					tbody.appendChild(this.buildSideRow(this.rows[i], false, i));
				}
				continue;
			}
			// Long equal run: collapse the middle behind a placeholder.
			const tbody = table.createEl("tbody", { cls: "gitee-sync-plus-diff-collapsed-body" });
			for (let i = seg.start; i < seg.start + ctx; i++) {
				tbody.appendChild(this.buildSideRow(this.rows[i], false, i));
			}
			const hidden = len - ctx * 2;
			const ph = tbody.createEl("tr", {
				cls: "gitee-sync-plus-diff-row gitee-sync-plus-diff-collapsed-placeholder",
			});
			ph.createEl("td", { cls: "gitee-sync-plus-diff-rb" });
			ph.createEl("td", { cls: "gitee-sync-plus-diff-num" }).setText("⋯");
			ph.createEl("td", { cls: "gitee-sync-plus-diff-cell" });
			ph.createEl("td", { cls: "gitee-sync-plus-diff-num" }).setText("⋯");
			ph.createEl("td", { cls: "gitee-sync-plus-diff-cell" }).setText(l.diffUnchangedLines(hidden));
			const frag = document.createDocumentFragment();
			for (let i = seg.start + ctx; i <= seg.end - ctx; i++) {
				frag.appendChild(this.buildSideRow(this.rows[i], true, i));
			}
			ph.after(frag);
			ph.addEventListener("click", () => tbody.toggleClass("is-expanded", true));
			for (let i = seg.end - ctx + 1; i <= seg.end; i++) {
				tbody.appendChild(this.buildSideRow(this.rows[i], false, i));
			}
		}
	}

	private buildSideRow(row: DiffRow, collapsible: boolean, rowIndex: number): HTMLTableRowElement {
		const tr = document.createElement("tr");
		tr.className =
			(collapsible ? "gitee-sync-plus-diff-row gitee-sync-plus-diff-collapsible " : "gitee-sync-plus-diff-row ") +
			`state-${row.state}`;
		if (this.rolledBack.has(rowIndex)) tr.addClass("is-rolled-back");

		// Rollback button column
		const rbCell = document.createElement("td");
		rbCell.className = "gitee-sync-plus-diff-rb";
		if (row.state !== "equal") {
			const rbBtn = rbCell.createEl("button", {
				cls: "gitee-sync-plus-diff-rb-btn",
				title: messages().diffRollback,
			});
			rbBtn.innerHTML = "&#x21A6;" /* ↦ */;
			rbBtn.addEventListener("click", () => {
				if (this.rolledBack.has(rowIndex)) this.rolledBack.delete(rowIndex);
				else this.rolledBack.add(rowIndex);
				this.render();
			});
		}
		tr.appendChild(rbCell);

		const leftNum = document.createElement("td");
		leftNum.className = "gitee-sync-plus-diff-num";
		leftNum.textContent = row.oldLine > 0 ? String(row.oldLine) : "";
		const leftCell = document.createElement("td");
		leftCell.className = "gitee-sync-plus-diff-cell" + (row.oldLine === 0 ? " gitee-sync-plus-diff-empty" : "");
		leftCell.textContent = row.oldText;
		const rightNum = document.createElement("td");
		rightNum.className = "gitee-sync-plus-diff-num";
		rightNum.textContent = row.newLine > 0 ? String(row.newLine) : "";
		const rightCell = document.createElement("td");
		rightCell.className = "gitee-sync-plus-diff-cell" + (row.newLine === 0 ? " gitee-sync-plus-diff-empty" : "");
		rightCell.textContent = row.newText;
		tr.append(leftNum, leftCell, rightNum, rightCell);
		return tr;
	}

	private renderUnified(): void {
		const l = messages();
		const ctx = this.contextLines;
		const wrapper = this.bodyEl.createDiv(
			"gitee-sync-plus-diff-files gitee-sync-plus-diff-files-unified"
		);
		const section = wrapper.createDiv(
			"gitee-sync-plus-diff-section gitee-sync-plus-diff-section-unified"
		);
		const label = section.createDiv("gitee-sync-plus-diff-section-label");
		label.setText(`${l.diffLeftLocal} → ${l.diffRightRemote}`);
		const scrollBox = section.createDiv("gitee-sync-plus-diff-section-scroll");
		const table = scrollBox.createEl("table", {
			cls: "gitee-sync-plus-diff-table gitee-sync-plus-diff-table-unified",
		});

		for (const seg of this.buildSegments()) {
			const len = seg.end - seg.start + 1;
			if (seg.type === "diff" || len <= ctx * 2 || !this.collapseUnchanged) {
				const tbody = table.createEl("tbody");
				for (let i = seg.start; i <= seg.end; i++) {
					for (const el of this.buildUnifiedRows(this.rows[i], false, i)) tbody.appendChild(el);
				}
				continue;
			}
			const tbody = table.createEl("tbody", { cls: "gitee-sync-plus-diff-collapsed-body" });
			for (let i = seg.start; i < seg.start + ctx; i++) {
				for (const el of this.buildUnifiedRows(this.rows[i], false, i)) tbody.appendChild(el);
			}
			const hidden = len - ctx * 2;
			const ph = tbody.createEl("tr", {
				cls: "gitee-sync-plus-diff-row gitee-sync-plus-diff-collapsed-placeholder",
			});
			ph.createEl("td", { cls: "gitee-sync-plus-diff-rb" });
			ph.createEl("td", { cls: "gitee-sync-plus-diff-num" }).setText("⋯");
			ph.createEl("td", { cls: "gitee-sync-plus-diff-unified-sign" });
			ph.createEl("td", { cls: "gitee-sync-plus-diff-cell" }).setText(l.diffUnchangedLines(hidden));
			const frag = document.createDocumentFragment();
			for (let i = seg.start + ctx; i <= seg.end - ctx; i++) {
				for (const el of this.buildUnifiedRows(this.rows[i], true, i)) frag.appendChild(el);
			}
			ph.after(frag);
			ph.addEventListener("click", () => tbody.toggleClass("is-expanded", true));
			for (let i = seg.end - ctx + 1; i <= seg.end; i++) {
				for (const el of this.buildUnifiedRows(this.rows[i], false, i)) tbody.appendChild(el);
			}
		}
	}

	private buildUnifiedRows(row: DiffRow, collapsible: boolean, rowIndex: number): HTMLTableRowElement[] {
		const cls = collapsible ? " gitee-sync-plus-diff-collapsible" : "";
		const mk = (num: number, sign: string, text: string, state: string): HTMLTableRowElement => {
			const tr = document.createElement("tr");
			tr.className = `gitee-sync-plus-diff-row${cls} state-${state}`;
			if (this.rolledBack.has(rowIndex)) tr.addClass("is-rolled-back");

			// Rollback button column
			const rbCell = document.createElement("td");
			rbCell.className = "gitee-sync-plus-diff-rb";
			if (state !== "equal") {
				const rbBtn = rbCell.createEl("button", {
					cls: "gitee-sync-plus-diff-rb-btn",
					title: messages().diffRollback,
				});
				rbBtn.innerHTML = "&#x21A6;" /* ↦ */;
				rbBtn.addEventListener("click", () => {
					if (this.rolledBack.has(rowIndex)) this.rolledBack.delete(rowIndex);
					else this.rolledBack.add(rowIndex);
					this.render();
				});
			}
			tr.appendChild(rbCell);

			const numTd = document.createElement("td");
			numTd.className = "gitee-sync-plus-diff-num";
			numTd.textContent = num > 0 ? String(num) : "";
			const signTd = document.createElement("td");
			signTd.className = "gitee-sync-plus-diff-unified-sign";
			signTd.textContent = sign;
			const cell = document.createElement("td");
			cell.className = "gitee-sync-plus-diff-cell";
			cell.textContent = text;
			tr.append(numTd, signTd, cell);
			return tr;
		};
		if (row.state === "equal") return [mk(row.oldLine, " ", row.oldText, "equal")];
		if (row.state === "delete") return [mk(row.oldLine, "-", row.oldText, "delete")];
		if (row.state === "insert") return [mk(row.newLine, "+", row.newText, "insert")];
		// change: removed locally, added remotely
		return [
			mk(row.oldLine, "-", row.oldText, "delete"),
			mk(row.newLine, "+", row.newText, "insert"),
		];
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
