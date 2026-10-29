import { App, Modal, Notice } from "obsidian";
import type CloudSyncPlugin from "../main";
import { createBackend } from "../backends/index";
import { messages } from "../utils/i18n";
import {
	computeDiffRows,
	splitLines,
	type DiffRow,
} from "./diff-view";
import type { ConflictEntry, ConflictResolution } from "../utils/engine";
import { ConflictDiffModal } from "./conflict-diff-modal";

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
			icon = "\u25CF"; /* ● */
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
		this.confirmBtn = right.createEl("button", {
			text: l.conflictConfirmPull,
			cls: "mod-cta",
		});
		this.confirmBtn.addEventListener("click", () => this.confirm());
		this.updateFooter();
	}

	private confirmBtn!: HTMLButtonElement;

	private updateFooter(): void {
		const done = this.resolutions.size;
		const total = this.conflicts.length;
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
