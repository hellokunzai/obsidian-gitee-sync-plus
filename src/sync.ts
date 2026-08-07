import { Vault } from "obsidian";
import { createBackend, RemoteEntry, StorageBackend } from "./backend";
import { formatDateTime, messages } from "./i18n";
import type CloudSyncPlugin from "./main";

/** Diagnostic log note. Excluded from sync via .gitignore so it never travels between devices. */
export const LOG_FILE = "_gitee-sync-log.md";

export interface SyncSummary {
	pushed: number;
	pulled: number;
	deletedLocal: number;
	deletedRemote: number;
	conflicts: number;
}

interface LocalEntry {
	path: string;
	hash: string;
	mtime: number;
}

export interface SyncPlan {
	localCount: number;
	remoteCount: number;
	baseCount: number;
	unchanged: number;
	conflicts: number;
	pulls: { path: string; rem: RemoteEntry; reason: string }[];
	localDeletes: { path: string; loc: LocalEntry; reason: string }[];
	pushes: { path: string; loc: LocalEntry; rem?: RemoteEntry; reason: string }[];
	remoteDeletes: { path: string; rem: RemoteEntry; reason: string }[];
	/** Baseline entries for paths already identical on both sides. */
	nextState: Record<string, string>;
}

/**
 * Three-way sync: compares local vault, remote manifest and the state recorded
 * at the last successful sync, so it can distinguish "changed here" from
 * "changed there" and propagate deletions in both directions.
 * When both sides changed the same file, the newer mtime wins.
 *
 * All file I/O goes through vault.adapter (not vault.* methods) so that
 * hidden files and directories — which Obsidian does not index — can be
 * synced correctly.  Exclusion is controlled entirely by .gitignore.
 */
export class SyncEngine {
	constructor(private plugin: CloudSyncPlugin) {}

	private get vault(): Vault {
		return this.plugin.app.vault;
	}

	private isExcluded(path: string): boolean {
		return this.plugin.gitIgnoreManager.isIgnored(path);
	}

	/** Dry run: build and describe the plan without transferring anything. */
	async preview(): Promise<{ plan: SyncPlan; report: string }> {
		const backend = createBackend(this.plugin.settings);
		const plan = await this.buildPlan(backend);
		return { plan, report: this.formatPlan(plan, messages().previewTitle) };
	}

	async run(): Promise<SyncSummary> {
		const l = messages();
		const backend = createBackend(this.plugin.settings);
		const plan = await this.buildPlan(backend);
		if (this.plugin.settings.debugLog) {
			await this.plugin.appendLog(this.formatPlan(plan, l.executionTitle));
		}

		const summary: SyncSummary = {
			pushed: 0,
			pulled: 0,
			deletedLocal: 0,
			deletedRemote: 0,
			conflicts: plan.conflicts,
		};
		const nextState = { ...plan.nextState };
		const step = async (path: string, fn: () => Promise<void>) => {
			try {
				await fn();
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				throw new Error(l.pathFailed(path, msg));
			}
		};

		try {
			// Phase 1: bring remote changes in. An interrupted sync only ever
			// leaves local work undone — the remote stays intact.
			for (const { path, rem } of plan.pulls) {
				await step(path, async () => {
					const { data, hash, mtime } = await backend.download(path);
					const localMtime = await this.writeLocal(path, data, mtime || rem.mtime);
					const finalHash = hash || rem.hash;
					nextState[path] = finalHash;
					this.plugin.hashCache[path] = {
						mtime: localMtime,
						size: data.byteLength,
						hash: finalHash,
						algo: backend.id,
					};
					summary.pulled++;
				});
			}
			for (const { path, loc } of plan.localDeletes) {
				await step(path, async () => {
					await this.vault.adapter.remove(loc.path);
					delete this.plugin.hashCache[path];
					summary.deletedLocal++;
				});
			}

			// Phase 2: send local changes out (sha-guarded, so a concurrent remote
			// change surfaces as an API error instead of a silent overwrite).
			for (const { path, loc, rem } of plan.pushes) {
				await step(path, async () => {
					const data = await this.vault.adapter.readBinary(loc.path);
					await backend.upload(path, data, {
						hash: loc.hash,
						mtime: loc.mtime,
						remoteHash: rem?.hash,
					});
					nextState[path] = loc.hash;
					summary.pushed++;
				});
			}
			for (const { path, rem } of plan.remoteDeletes) {
				await step(path, async () => {
					await backend.remove(path, rem.hash);
					summary.deletedRemote++;
				});
			}
		} catch (e) {
			// Persist what already succeeded so a re-run doesn't redo it.
			this.plugin.syncState = nextState;
			await this.plugin.savePluginData();
			if (this.plugin.settings.debugLog) {
				await this.plugin.appendLog(
					l.resultFailed(e instanceof Error ? e.message : String(e)) +
						l.completedCounts(
							summary.pulled,
							summary.pushed,
							summary.deletedLocal,
							summary.deletedRemote
						)
				);
			}
			throw e;
		}

		this.plugin.syncState = nextState;
		await this.plugin.savePluginData();
		if (this.plugin.settings.debugLog) {
			await this.plugin.appendLog(
				l.resultSuccess(
					summary.pulled,
					summary.pushed,
					summary.deletedLocal,
					summary.deletedRemote,
					summary.conflicts
				)
			);
		}
		return summary;
	}

	private async buildPlan(backend: StorageBackend): Promise<SyncPlan> {
		await this.plugin.gitIgnoreManager.load();
		const l = messages();
		const [remoteList, local] = await Promise.all([
			backend.manifest(),
			this.buildLocalManifest(backend),
		]);
		const remote = new Map<string, RemoteEntry>(
			remoteList.filter((e) => !this.isExcluded(e.path)).map((e) => [e.path, e])
		);
		const base = this.plugin.syncState;
		const basePaths = Object.keys(base).filter((p) => !this.isExcluded(p));

		const plan: SyncPlan = {
			localCount: local.size,
			remoteCount: remote.size,
			baseCount: basePaths.length,
			unchanged: 0,
			conflicts: 0,
			pulls: [],
			localDeletes: [],
			pushes: [],
			remoteDeletes: [],
			nextState: {},
		};

		const allPaths = new Set<string>([...local.keys(), ...remote.keys(), ...basePaths]);

		for (const path of allPaths) {
			const loc = local.get(path);
			const rem = remote.get(path);
			const baseHash = base[path];

			// Already identical on both sides.
			if (loc && rem && loc.hash === rem.hash) {
				plan.nextState[path] = loc.hash;
				plan.unchanged++;
				continue;
			}
			// Deleted on both sides (or never existed anymore).
			if (!loc && !rem) continue;

			const localChanged = loc?.hash !== baseHash;
			const remoteChanged = rem?.hash !== baseHash;
			const isNew = baseHash === undefined;

			if (localChanged && !remoteChanged) {
				if (loc)
					plan.pushes.push({
						path,
						loc,
						rem,
						reason: isNew ? l.reasonLocalAdded : l.reasonLocalModified,
					});
				else if (rem) plan.remoteDeletes.push({ path, rem, reason: l.reasonLocalDeleted });
			} else if (remoteChanged && !localChanged) {
				if (rem)
					plan.pulls.push({
						path,
						rem,
						reason: isNew ? l.reasonRemoteAdded : l.reasonRemoteModified,
					});
				else if (loc) plan.localDeletes.push({ path, loc, reason: l.reasonRemoteDeleted });
			} else {
				// Both sides changed since the last sync: newer mtime wins;
				// a modification beats a deletion.
				plan.conflicts++;
				if (loc && rem) {
					const remoteMtime = await this.remoteMtime(backend, path, rem);
					if (loc.mtime >= remoteMtime) {
						plan.pushes.push({
							path,
							loc,
							rem,
							reason: l.reasonConflictLocalNewer(ts(loc.mtime), ts(remoteMtime)),
						});
					} else {
						plan.pulls.push({
							path,
							rem,
							reason: l.reasonConflictRemoteNewer(ts(remoteMtime), ts(loc.mtime)),
						});
					}
				} else if (loc) {
					plan.pushes.push({ path, loc, rem, reason: l.reasonConflictKeepLocal });
				} else if (rem) {
					plan.pulls.push({ path, rem, reason: l.reasonConflictKeepRemote });
				}
			}
		}
		return plan;
	}

	private formatPlan(plan: SyncPlan, title: string): string {
		const l = messages();
		const s = this.plugin.settings;
		const target =
			s.backend === "github"
				? `github ${s.githubOwner}/${s.githubRepo}@${s.githubBranch}`
				: `gitee ${s.giteeOwner}/${s.giteeRepo}@${s.giteeBranch}`;
		const lines: string[] = [];
		lines.push(`\n## ${title} ${formatDateTime()}`);
		lines.push(
			l.planBackend(target) +
				"\n" +
				l.planCounts(
					plan.localCount,
					plan.remoteCount,
					plan.baseCount,
					plan.unchanged,
					plan.conflicts
				)
		);
		const total =
			plan.pulls.length + plan.pushes.length + plan.localDeletes.length + plan.remoteDeletes.length;
		if (total === 0) {
			lines.push(l.planNoActions);
		} else {
			lines.push(
				l.planActions(
					plan.pulls.length,
					plan.pushes.length,
					plan.localDeletes.length,
					plan.remoteDeletes.length
				)
			);
			for (const a of plan.pulls)
				lines.push(`- ⬇️ ${l.actionDownload} \`${a.path}\` — ${a.reason}`);
			for (const a of plan.localDeletes)
				lines.push(`- 🗑️ ${l.actionDeleteLocal} \`${a.path}\` — ${a.reason}`);
			for (const a of plan.pushes)
				lines.push(`- ⬆️ ${l.actionUpload} \`${a.path}\` — ${a.reason}`);
			for (const a of plan.remoteDeletes)
				lines.push(`- ❌ ${l.actionDeleteRemote} \`${a.path}\` — ${a.reason}`);
		}
		return lines.join("\n") + "\n";
	}

	private async remoteMtime(
		backend: StorageBackend,
		path: string,
		rem: RemoteEntry
	): Promise<number> {
		if (rem.mtime > 0 || !backend.statMtime) return rem.mtime;
		try {
			return await backend.statMtime(path);
		} catch {
			return 0;
		}
	}

	/**
	 * Recursively lists every file under `dir` (including hidden files/dirs)
	 * using the low-level adapter, which bypasses Obsidian's file-index filter.
	 *
	 * On Windows the adapter may return entries as full vault-relative paths
	 * (e.g. ".git\\hooks") rather than bare names.  We detect and handle both
	 * forms to avoid path-doubling bugs like ".git/.git/hooks".
	 */
	private async listAllFiles(dir: string): Promise<string[]> {
		const result: string[] = [];
		const listing = await this.vault.adapter.list(dir);

		const dirNorm = dir.replace(/\\/g, "/");
		const joinPath = (name: string): string => {
			const norm = name.replace(/\\/g, "/");
			// adapter already returned a full vault-relative path
			if (dirNorm && (norm === dirNorm || norm.startsWith(dirNorm + "/"))) {
				return norm;
			}
			return dirNorm ? `${dirNorm}/${norm}` : norm;
		};

		for (const file of listing.files) {
			result.push(joinPath(file));
		}
		for (const folder of listing.folders) {
			const subDir = joinPath(folder);
			// Early skip: don't recurse into excluded directories
			if (this.isExcluded(subDir) || this.isExcluded(subDir + "/")) continue;
			const subFiles = await this.listAllFiles(subDir);
			result.push(...subFiles);
		}
		return result;
	}

	/** Builds { path -> hash } for the vault, reusing cached hashes when mtime+size are unchanged. */
	private async buildLocalManifest(backend: StorageBackend): Promise<Map<string, LocalEntry>> {
		const result = new Map<string, LocalEntry>();
		const cache = this.plugin.hashCache;
		const seen = new Set<string>();
		const adapter = this.vault.adapter;

		const allFiles = await this.listAllFiles("");

		for (const path of allFiles) {
			if (this.isExcluded(path)) continue;
			seen.add(path);
			const stat = await adapter.stat(path);
			if (!stat || stat.type !== "file") continue;
			const cached = cache[path];
			let hash: string;
			if (
				cached &&
				cached.algo === backend.id &&
				cached.mtime === stat.mtime &&
				cached.size === stat.size
			) {
				hash = cached.hash;
			} else {
				hash = await backend.hashData(await adapter.readBinary(path));
				cache[path] = {
					mtime: stat.mtime,
					size: stat.size,
					hash,
					algo: backend.id,
				};
			}
			result.set(path, { path, hash, mtime: stat.mtime });
		}

		for (const path of Object.keys(cache)) {
			if (!seen.has(path)) delete cache[path];
		}
		return result;
	}

	/** Writes the file and returns its resulting local mtime (for the hash cache). */
	private async writeLocal(path: string, data: ArrayBuffer, mtime: number): Promise<number> {
		const dir = path.split("/").slice(0, -1).join("/");
		if (dir) await this.ensureFolder(dir);
		await this.vault.adapter.writeBinary(path, data);
		const stat = await this.vault.adapter.stat(path);
		return stat ? stat.mtime : mtime;
	}

	private async ensureFolder(dir: string): Promise<void> {
		const parts = dir.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!(await this.vault.adapter.exists(current))) {
				try {
					await this.vault.adapter.mkdir(current);
				} catch {
					// Folder may have been created concurrently; ignore.
				}
			}
		}
	}
}

function ts(ms: number): string {
	return ms > 0 ? formatDateTime(new Date(ms)) : messages().unknown;
}
