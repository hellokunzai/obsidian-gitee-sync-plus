import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import type CloudSyncPlugin from "./main";
import { createBackend } from "./backend";
import { messages } from "./i18n";

export const DIFF_VIEW_TYPE = "gitee-sync-plus-diff";

export type DiffKind = "local-mod" | "local-add" | "local-del" | "remote-mod" | "remote-del";

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
	private diffContentEl!: HTMLElement;
	private busy = false;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	private get plugin(): CloudSyncPlugin {
		// App.plugins is not exposed in all Obsidian API versions; cast as needed.
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
		void this.loadDiff();
	}

	getState(): DiffState {
		return this.viewState ?? { path: "", kind: "local-mod" };
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("gitee-sync-plus-diff");

		const header = container.createDiv("gitee-sync-plus-diff-header");
		this.diffContentEl = container.createDiv("gitee-sync-plus-diff-content");

		// Path label is updated once state is known.
		header.createEl("span", { cls: "gitee-sync-plus-diff-path" });

		if (this.viewState) {
			void this.loadDiff();
		}
	}

	private updateTitle(): void {
		this.leaf.view.getDisplayText = () => this.getDisplayText();
		const header = this.containerEl.querySelector(".gitee-sync-plus-diff-path");
		if (header) header.setText(this.getDisplayText());
	}

	private async loadDiff(): Promise<void> {
		if (this.busy || !this.viewState) return;
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
					const { data } = await backend.download(path);
					beforeText = this.decodeText(data);
					afterText = await this.readLocalText(path);
					beforeLabel = l.diffLeftRemote;
					afterLabel = l.diffRightLocal;
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
					const { data } = await backend.download(path);
					afterText = this.decodeText(data);
					beforeLabel = l.diffLeftLocal;
					afterLabel = l.diffRightRemote;
					break;
				}
				case "remote-del": {
					beforeText = await this.readLocalText(path);
					beforeLabel = l.diffLeftLocal;
					afterLabel = l.diffRightEmpty;
					break;
				}
			}

			this.renderDiff(path, beforeText, afterText, beforeLabel, afterLabel);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.diffContentEl.empty();
			this.diffContentEl.createEl("p", {
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

	private renderDiff(
		path: string,
		beforeText: string,
		afterText: string,
		beforeLabel: string,
		afterLabel: string
	): void {
		this.diffContentEl.empty();
		const l = messages();

		const header = this.containerEl.querySelector(".gitee-sync-plus-diff-path");
		if (header) header.setText(`${path} — ${l.diffTitle}`);

		const beforeLines = splitLines(beforeText);
		const afterLines = splitLines(afterText);
		const rows = computeDiffRows(beforeLines, afterLines);

		// Legend / column labels
		const labels = this.diffContentEl.createDiv("gitee-sync-plus-diff-labels");
		labels.createSpan({ text: beforeLabel, cls: "gitee-sync-plus-diff-label gitee-sync-plus-diff-label-left" });
		labels.createSpan({ text: afterLabel, cls: "gitee-sync-plus-diff-label gitee-sync-plus-diff-label-right" });

		const table = this.diffContentEl.createEl("table", { cls: "gitee-sync-plus-diff-table" });
		for (const row of rows) {
			const tr = table.createEl("tr", { cls: `gitee-sync-plus-diff-row state-${row.state}` });

			const leftNum = tr.createEl("td", { cls: "gitee-sync-plus-diff-num" });
			const leftCell = tr.createEl("td", { cls: "gitee-sync-plus-diff-cell" });
			const rightNum = tr.createEl("td", { cls: "gitee-sync-plus-diff-num" });
			const rightCell = tr.createEl("td", { cls: "gitee-sync-plus-diff-cell" });

			if (row.state === "equal") {
				leftNum.setText(String(row.oldLine));
				rightNum.setText(String(row.newLine));
				leftCell.setText(row.oldText);
				rightCell.setText(row.newText);
			} else if (row.state === "delete") {
				leftNum.setText(String(row.oldLine));
				leftCell.setText(row.oldText);
			} else if (row.state === "insert") {
				rightNum.setText(String(row.newLine));
				rightCell.setText(row.newText);
			} else {
				// change: show both sides; line numbers come from the original line positions.
				leftNum.setText(row.oldLine > 0 ? String(row.oldLine) : "");
				rightNum.setText(row.newLine > 0 ? String(row.newLine) : "");
				leftCell.setText(row.oldText);
				rightCell.setText(row.newText);
			}

			// Empty cells in delete/insert rows get a subtle dimming via CSS.
			if (row.state === "delete") {
				rightCell.addClass("gitee-sync-plus-diff-empty");
			} else if (row.state === "insert") {
				leftCell.addClass("gitee-sync-plus-diff-empty");
			}
		}
	}
}

function splitLines(text: string): string[] {
	if (text === "") return [];
	// Keep line endings out of the diff display.
	return text.split(/\r?\n/);
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

	// Build index of lines in newLines for fast look-ahead.
	const newIndex = new Map<string, number[]>();
	for (let idx = 0; idx < newLines.length; idx++) {
		const line = newLines[idx];
		const list = newIndex.get(line);
		if (list) list.push(idx);
		else newIndex.set(line, [idx]);
	}

	while (i < oldLines.length || j < newLines.length) {
		if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
			rows.push({
				oldLine,
				newLine,
				oldText: oldLines[i],
				newText: newLines[j],
				state: "equal",
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

		// Find the next matching line in oldLines at or after i.
		let nextMatchOld = -1;
		if (j < newLines.length) {
			for (let k = i; k < oldLines.length; k++) {
				if (oldLines[k] === newLines[j]) {
					nextMatchOld = k;
					break;
				}
			}
		}

		// Decide whether to consume deletions, insertions, or a change block.
		if (nextMatchNew === -1 && nextMatchOld === -1) {
			// No more equal lines: consume the rest as paired changes.
			const oldChunk = oldLines.slice(i);
			const newChunk = newLines.slice(j);
			pushChangeBlock(rows, oldChunk, newChunk, oldLine, newLine);
			break;
		}

		if (nextMatchNew !== -1 && (nextMatchOld === -1 || nextMatchNew - j <= nextMatchOld - i)) {
			// New lines were inserted before matching old line i.
			const inserted = newLines.slice(j, nextMatchNew);
			for (const line of inserted) {
				rows.push({ oldLine: 0, newLine, oldText: "", newText: line, state: "insert" });
				newLine++;
			}
			j = nextMatchNew;
		} else {
			// Old lines were deleted before matching new line j.
			const deleted = oldLines.slice(i, nextMatchOld);
			for (const line of deleted) {
				rows.push({ oldLine, newLine: 0, oldText: line, newText: "", state: "delete" });
				oldLine++;
			}
			i = nextMatchOld;
		}
	}

	return rows;
}

function pushChangeBlock(
	rows: DiffRow[],
	oldChunk: string[],
	newChunk: string[],
	oldStart: number,
	newStart: number
): void {
	const len = Math.max(oldChunk.length, newChunk.length);
	for (let k = 0; k < len; k++) {
		const oldText = oldChunk[k] ?? "";
		const newText = newChunk[k] ?? "";
		rows.push({
			oldLine: k < oldChunk.length ? oldStart + k : 0,
			newLine: k < newChunk.length ? newStart + k : 0,
			oldText,
			newText,
			state: oldText === newText ? "equal" : "change",
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
