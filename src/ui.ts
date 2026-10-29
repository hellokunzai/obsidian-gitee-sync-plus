import { App, Modal, getIconIds, setIcon, setTooltip } from "obsidian";
import { messages } from "./utils/i18n";

/**
 * Lucide icon names vary between Obsidian releases, so every call site passes
 * an ordered candidate list (best match first) and we render the first one the
 * running build actually ships. When `getIconIds()` is unavailable (older
 * builds) we fall back to the glyph so a button is never blank.
 */
let availableIcons: Set<string> | null | undefined;

function iconSet(): Set<string> | null {
	if (availableIcons === undefined) {
		try {
			availableIcons = new Set(getIconIds());
		} catch {
			// getIconIds() not present on this build: we can't enumerate icons,
			// but setIcon() still works for known names, so we return null and
			// resolveIconName() will best-effort pick the first candidate.
			availableIcons = null;
		}
	}
	return availableIcons;
}

/** Returns the first icon name the running Obsidian build ships, or null. */
export function resolveIconName(candidates: readonly string[]): string | null {
	const known = iconSet();
	if (known === null) return candidates[0] ?? null;
	for (const name of candidates) {
		if (known.has(name)) return name;
	}
	return null;
}

/**
 * Renders a Lucide icon into `el`, attaches a native Obsidian tooltip, and
 * falls back to a text glyph when no candidate exists — so a button can never
 * end up blank.
 */
export function applyIcon(
	el: HTMLElement,
	icons: readonly string[],
	tooltip: string,
	fallback?: string
): void {
	el.empty();
	const name = resolveIconName(icons);
	if (name) {
		try {
			setIcon(el, name);
		} catch {
			if (fallback) el.setText(fallback);
		}
	} else if (fallback) {
		el.setText(fallback);
	}
	if (tooltip) {
		setTooltip(el, tooltip, { placement: "top" });
		el.setAttribute("aria-label", tooltip);
	}
}

export interface IconButtonOptions {
	/** Icon names tried in order; the first one Obsidian ships wins. */
	icons: readonly string[];
	/** Tooltip text (already resolved through i18n). */
	tooltip: string;
	/** Glyph used when no candidate icon exists. */
	fallback?: string;
	/** Extra classes appended after `clickable-icon`. */
	cls?: string;
	onClick: (evt: MouseEvent) => void;
}

/** Creates a native Obsidian icon button: `.clickable-icon` + Lucide icon + native tooltip. */
export function createIconButton(parent: HTMLElement, opts: IconButtonOptions): HTMLButtonElement {
	const cls = opts.cls ? `clickable-icon ${opts.cls}` : "clickable-icon";
	const btn = parent.createEl("button", { cls });
	btn.setAttribute("type", "button");
	applyIcon(btn, opts.icons, opts.tooltip, opts.fallback);
	btn.addEventListener("click", opts.onClick);
	return btn;
}

export interface ConfirmOptions {
	title: string;
	message: string;
	/** Label of the destructive action. */
	confirmText: string;
	onConfirm: () => void;
}

/**
 * Self-built destructive-action confirmation modal.
 *
 * Mirrors Obsidian's modal styling (heading + body + secondary "取消" + primary
 * `mod-warning` confirm) without depending on the 1.13.0+ `ConfirmationModal`
 * API, so the plugin keeps `minAppVersion: 1.11.4`.
 */
export function confirmDanger(app: App, opts: ConfirmOptions): void {
	new FallbackConfirmModal(app, opts).open();
}

/** Self-built stand-in for the official confirm modal. */
class FallbackConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly opts: ConfirmOptions
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, titleEl, modalEl } = this;
		contentEl.empty();
		modalEl.addClass("gitee-sync-plus-confirm-modal");
		titleEl.setText(this.opts.title);
		contentEl.createEl("p", {
			text: this.opts.message,
			cls: "gitee-sync-plus-confirm-message",
		});
		const row = contentEl.createDiv("gitee-sync-plus-confirm-buttons");
		row
			.createEl("button", { text: messages().cancel })
			.addEventListener("click", () => this.close());
		row
			.createEl("button", { text: this.opts.confirmText, cls: "mod-warning" })
			.addEventListener("click", () => {
				this.close();
				this.opts.onConfirm();
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
