import { Vault } from "obsidian";
import ignore from "ignore";

const GITIGNORE_FILE = ".gitignore";

const MANAGED_START = "# >>> gitee-sync-plus managed exclusions >>>";
const MANAGED_END = "# <<< gitee-sync-plus managed exclusions <<<";

/**
 * Default .gitignore created when none exists.
 * These rules live in a user-editable file rather than being hardcoded in the plugin.
 */
const DEFAULT_GITIGNORE = [
	"# Git internal version control data, must never be synced",
	".git",
	"",
	"# Plugin diagnostic log",
	"_gitee-sync-plus-log.md",
	"",
	"# Obsidian trash directory",
	".trash",
	"",
	"# Obsidian workspace layout files, stores panel and tab states. Do not sync across different devices",
	".obsidian/workspace.json",
	".obsidian/workspace-mobile.json",
	".obsidian/plugins/gitee-sync-plus/data.json",
].join("\n");

/**
 * Manages .gitignore-based exclusion for the sync engine.
 *
 * - Reads .gitignore from the vault root and matches paths with the `ignore` library.
 * - Maintains a plugin-managed section inside .gitignore that mirrors the legacy
 *   "Excluded folders" setting.
 * - Creates a default .gitignore if none exists so that sensitive directories
 *   (e.g. .obsidian) are not synced by accident.
 */
export class GitIgnoreManager {
	private ig: ReturnType<typeof ignore>;
	private loaded = false;

	constructor(private vault: Vault) {
		this.ig = ignore();
	}

	/** Creates a default .gitignore only if the vault does not already have one. */
	async ensureExists(): Promise<void> {
		const adapter = this.vault.adapter;
		if (!(await adapter.exists(GITIGNORE_FILE))) {
			await adapter.write(GITIGNORE_FILE, DEFAULT_GITIGNORE);
		}
	}

	/** (Re)loads .gitignore from disk. Must be called before using isIgnored(). */
	async load(): Promise<void> {
		const adapter = this.vault.adapter;
		this.ig = ignore();
		if (await adapter.exists(GITIGNORE_FILE)) {
			const content = await adapter.read(GITIGNORE_FILE);
			this.ig.add(content);
		}
		this.loaded = true;
	}

	/** Returns true if the given vault-relative path is ignored by .gitignore. */
	isIgnored(path: string): boolean {
		if (!this.loaded) {
			return false;
		}
		return this.ig.ignores(path);
	}

	/** Reads the raw content of .gitignore from the vault root. */
	async readFullContent(): Promise<string> {
		const adapter = this.vault.adapter;
		if (!(await adapter.exists(GITIGNORE_FILE))) {
			return "";
		}
		return await adapter.read(GITIGNORE_FILE);
	}

	/** Overwrites .gitignore with the given raw content. */
	async writeFullContent(content: string): Promise<void> {
		const adapter = this.vault.adapter;
		await adapter.write(GITIGNORE_FILE, content);
	}

	/**
	 * Reads the plugin-managed exclusion list from .gitignore and returns it as a
	 * comma-separated string for the settings UI.
	 */
	async readManagedFolders(): Promise<string> {
		const adapter = this.vault.adapter;
		if (!(await adapter.exists(GITIGNORE_FILE))) {
			return "";
		}
		const content = await adapter.read(GITIGNORE_FILE);
		const block = this.extractManagedBlock(content);
		return block
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("#"))
			.map((line) => line.replace(/\/+$/, ""))
			.join(", ");
	}

	/**
	 * Writes the plugin-managed exclusion list back to .gitignore.
	 * Existing user entries outside the managed block are preserved.
	 */
	async writeManagedFolders(foldersText: string): Promise<void> {
		const adapter = this.vault.adapter;

		await this.ensureExists();
		let content = (await adapter.exists(GITIGNORE_FILE))
			? await adapter.read(GITIGNORE_FILE)
			: DEFAULT_GITIGNORE;

		const folders = foldersText
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0)
			.map((s) => s.replace(/\/+$/, ""));

		const managedBlock = [
			MANAGED_START,
			"# The following entries are managed by the Gitee Sync Plus plugin settings.",
			...folders.map((f) => `${f}/`),
			MANAGED_END,
		].join("\n");

		const start = content.indexOf(MANAGED_START);
		const end = content.indexOf(MANAGED_END);

		if (start !== -1 && end !== -1 && end > start) {
			content =
				content.slice(0, start) +
				managedBlock +
				content.slice(end + MANAGED_END.length);
		} else {
			content = content.trimEnd() + "\n\n" + managedBlock + "\n";
		}

		await adapter.write(GITIGNORE_FILE, content);
	}

	private extractManagedBlock(content: string): string {
		const start = content.indexOf(MANAGED_START);
		const end = content.indexOf(MANAGED_END);
		if (start === -1 || end === -1 || end <= start) {
			return "";
		}
		return content.slice(start + MANAGED_START.length, end);
	}
}
