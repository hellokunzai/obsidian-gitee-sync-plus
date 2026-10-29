import { Vault } from "obsidian";
import type { BatchDelete, BatchFileChange, RemoteEntry, StorageBackend } from "../types/backend";
import { createBackend } from "../backends/index";
import { formatDateTime, messages } from "../utils/i18n";
import type CloudSyncPlugin from "../main";

/** Diagnostic log note. Excluded from sync via .gitignore so it never travels between devices. */
export const LOG_FILE = "_gitee-sync-plus-log.md";

export interface SyncSummary {
	pushed: number;
	pulled: number;
	deletedLocal: number;
	deletedRemote: number;
	conflicts: number;
}

export interface LocalEntry {
	path: string;
	hash: string;
	mtime: number;
}

/** How a conflicting file should be resolved during a pull. */
export type ConflictResolution =
	| { action: "local" }
	| { action: "remote" }
	| { action: "merge"; content: string };

/** A file that was modified on both sides since the last successful sync. */
export interface ConflictEntry {
	path: string;
	/** Local version, if the file still exists locally. */
	loc?: LocalEntry;
	/** Remote version, if the file still exists remotely. */
	rem?: RemoteEntry;
	reason: string;
	/** The mtime-based default winner, used when no manual resolution is given. */
	preferred: "local" | "remote";
}

export interface SyncPlan {
	localCount: number;
	remoteCount: number;
	baseCount: number;
	unchanged: number;
	conflicts: number;
	pulls: { path: string; rem: RemoteEntry; reason: string; isConflict?: boolean }[];
	localDeletes: { path: string; loc: LocalEntry; reason: string; isConflict?: boolean }[];
	pushes: { path: string; loc: LocalEntry; rem?: RemoteEntry; reason: string; isConflict?: boolean }[];
	remoteDeletes: { path: string; rem: RemoteEntry; reason: string; isConflict?: boolean }[];
	/** Files changed on both sides since the last sync, surfaced for manual resolution. */
	conflictEntries: ConflictEntry[];
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

	/** Cache of the remote manifest to avoid repeated API calls during panel refreshes. */
	private manifestCache: { entries: RemoteEntry[]; ts: number } | null = null;
	private readonly MANIFEST_CACHE_TTL = 5000;
	/**
	 * Cache of LF-normalized remote hashes. The sync engine compares local files
	 * by their LF-normalized hash, but the remote manifest stores raw git blob
	 * SHAs. This cache lets us avoid downloading the same remote file repeatedly
	 * just to check whether a hash mismatch is only a line-ending difference.
	 */
	private normalizedRemoteCache = new Map<
		string,
		{ rawHash: string; normalizedHash: string; ts: number }
	>();
	private readonly NORMALIZED_REMOTE_CACHE_TTL = 60000;

	private async fetchManifest(backend: StorageBackend): Promise<RemoteEntry[]> {
		if (this.manifestCache && Date.now() - this.manifestCache.ts < this.MANIFEST_CACHE_TTL) {
			return this.manifestCache.entries;
		}
		const entries = await backend.manifest();
		this.manifestCache = { entries, ts: Date.now() };
		return entries;
	}

	/** Drops cached remote state; call before mutating operations. */
	invalidateCaches(): void {
		this.manifestCache = null;
		this.normalizedRemoteCache.clear();
	}

	/**
	 * Returns the hash the remote file would have if its line endings were
	 * normalized to LF. Local hashes are always computed over LF-normalized
	 * content, so comparing with this value lets the sync plan ignore CRLF-vs-LF
	 * differences that are not meaningful content changes.
	 */
	private async getNormalizedRemoteHash(
		backend: StorageBackend,
		path: string,
		rem: RemoteEntry
	): Promise<string> {
		const cached = this.normalizedRemoteCache.get(path);
		if (
			cached &&
			cached.rawHash === rem.hash &&
			Date.now() - cached.ts < this.NORMALIZED_REMOTE_CACHE_TTL
		) {
			return cached.normalizedHash;
		}
		const { data } = await backend.download(path);
		const normalized = normalizeLineEndings(data);
		const normalizedHash = await backend.hashData(normalized);
		this.normalizedRemoteCache.set(path, {
			rawHash: rem.hash,
			normalizedHash,
			ts: Date.now(),
		});
		return normalizedHash;
	}

	/** Dry run: build and describe the plan without transferring anything. */
	async preview(): Promise<{ plan: SyncPlan; report: string }> {
		const backend = createBackend(this.plugin.settings);
		const plan = await this.buildPlan(backend);
		return { plan, report: this.formatPlan(plan, messages().previewTitle) };
	}

	async run(message?: string): Promise<SyncSummary> {
		this.invalidateCaches();
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

		try {
			await this.executePull(backend, plan, nextState, summary);
			await this.executePush(backend, plan, nextState, summary, { message });
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

	/** Builds the three-way sync plan without transferring anything. */
	async computePlan(opts?: { forPanel?: boolean }): Promise<SyncPlan> {
		return this.buildPlan(createBackend(this.plugin.settings), opts);
	}

	/** Phase 1 only: download remote changes and apply remote deletions.
	 * When `conflictResolutions` is supplied (the pull-button flow), conflicting
	 * files are resolved manually instead of by mtime, and the conflict-derived
	 * auto-pull/push entries are skipped. */
	async pullRemote(
		conflictResolutions?: Map<string, ConflictResolution>
	): Promise<SyncSummary> {
		this.invalidateCaches();
		const backend = createBackend(this.plugin.settings);
		const plan = await this.buildPlan(backend);
		const summary: SyncSummary = {
			pushed: 0,
			pulled: 0,
			deletedLocal: 0,
			deletedRemote: 0,
			conflicts: plan.conflicts,
		};
		const nextState = { ...plan.nextState };
		try {
			await this.executePull(backend, plan, nextState, summary, conflictResolutions);
		} catch (e) {
			this.plugin.syncState = nextState;
			await this.plugin.savePluginData();
			throw e;
		}
		this.plugin.syncState = nextState;
		await this.plugin.savePluginData();
		return summary;
	}

	/**
	 * Phase 2 only: push local changes (and remote deletions). When commitMode
	 * is "batch", `message` overrides the auto-generated batch commit message.
	 * If `staged` is provided, only the local-change paths in that set are sent;
	 * the rest remain in the working tree for a later commit.
	 */
	async pushLocal(message?: string, staged?: Set<string>): Promise<SyncSummary> {
		this.invalidateCaches();
		const backend = createBackend(this.plugin.settings);
		const plan = await this.buildPlan(backend);
		const summary: SyncSummary = {
			pushed: 0,
			pulled: 0,
			deletedLocal: 0,
			deletedRemote: 0,
			conflicts: plan.conflicts,
		};
		const nextState = { ...plan.nextState };
		try {
			await this.executePush(backend, plan, nextState, summary, { message, staged });
		} catch (e) {
			this.plugin.syncState = nextState;
			await this.plugin.savePluginData();
			throw e;
		}
		this.plugin.syncState = nextState;
		await this.plugin.savePluginData();
		return summary;
	}

	/**
	 * Discards local working-tree changes for the given paths so they will no
	 * longer be pushed on the next sync:
	 * - a file that exists remotely → download the remote copy, overwriting the
	 *   local edit (reverts to the last synced version);
	 * - a newly added local file (not on remote) → delete the local copy.
	 * Only entries in plan.pushes are eligible — these are changes introduced
	 * locally since the last successful sync.
	 */
	async discardChanges(plan: SyncPlan, paths: string[]): Promise<number> {
		const backend = createBackend(this.plugin.settings);
		const wanted = new Set(paths);
		const nextState = { ...this.plugin.syncState };
		let count = 0;
		for (const p of plan.pushes) {
			if (!wanted.has(p.path)) continue;
			if (p.rem) {
				let { data, mtime } = await backend.download(p.path);
				data = normalizeLineEndings(data);
				const localMtime = await this.writeLocal(p.path, data, mtime || p.rem.mtime);
				const finalHash = await backend.hashData(data);
				nextState[p.path] = finalHash;
				this.plugin.hashCache[p.path] = {
					mtime: localMtime,
					size: data.byteLength,
					hash: finalHash,
					algo: backend.id,
				};
			} else {
				if (await this.vault.adapter.exists(p.path)) {
					await this.vault.adapter.remove(p.path);
				}
				delete this.plugin.hashCache[p.path];
				delete nextState[p.path];
			}
			count++;
		}
		this.plugin.syncState = nextState;
		await this.plugin.savePluginData();
		return count;
	}

	private async executePull(
		backend: StorageBackend,
		plan: SyncPlan,
		nextState: Record<string, string>,
		summary: SyncSummary,
		conflictResolutions?: Map<string, ConflictResolution>
	): Promise<void> {
		const l = messages();
		const conflictMode = !!conflictResolutions;
		const step = async (path: string, fn: () => Promise<void>) => {
			try {
				await fn();
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				throw new Error(l.pathFailed(path, msg));
			}
		};
		// Phase 1: bring remote changes in. An interrupted sync only ever
		// leaves local work undone — the remote stays intact.
		// In conflict mode the conflict-derived auto-pulls are skipped and
		// handled manually below, so they aren't overwritten silently.
		for (const entry of plan.pulls) {
			if (conflictMode && entry.isConflict) continue;
			const { path, rem } = entry;
			await step(path, async () => {
				let { data, mtime } = await backend.download(path);
				data = normalizeLineEndings(data);
				const localMtime = await this.writeLocal(path, data, mtime || rem.mtime);
				const finalHash = await backend.hashData(data);
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
		for (const { path, loc, isConflict } of plan.localDeletes) {
			if (conflictMode && isConflict) continue;
			await step(path, async () => {
				await this.vault.adapter.remove(loc.path);
				delete this.plugin.hashCache[path];
				summary.deletedLocal++;
			});
		}
		// Manually resolve conflicts when resolutions were supplied.
		if (conflictMode) {
			for (const c of plan.conflictEntries) {
				const res = conflictResolutions!.get(c.path);
				const action: "local" | "remote" | "merge" = res
					? res.action
					: c.preferred === "local"
						? "local"
						: "remote";
				await step(c.path, async () => {
					if (action === "local") {
						// Keep the local copy; record it as the new baseline.
						if (c.loc) {
							nextState[c.path] = c.loc.hash;
						} else if (await this.vault.adapter.exists(c.path)) {
							await this.vault.adapter.remove(c.path);
							delete this.plugin.hashCache[c.path];
							delete nextState[c.path];
						}
						return;
					}
					// 'remote' or 'merge' → write the resolved content.
					let data: ArrayBuffer;
					let sourceMtime: number;
					if (action === "merge" && res && res.action === "merge") {
						data = encodeText(res.content);
						sourceMtime = c.loc?.mtime ?? 0;
					} else if (c.rem) {
						const dl = await backend.download(c.path);
						data = normalizeLineEndings(dl.data);
						sourceMtime = dl.mtime || c.rem.mtime || 0;
					} else {
						// Conflict resolved to "remote" but no remote copy (e.g.
						// local was deleted and remote was modified): nothing to
						// download — keep the local deletion.
						if (c.loc && (await this.vault.adapter.exists(c.path))) {
							await this.vault.adapter.remove(c.path);
							delete this.plugin.hashCache[c.path];
							delete nextState[c.path];
						}
						return;
					}
					const localMtime = await this.writeLocal(c.path, data, sourceMtime);
					const finalHash = await backend.hashData(data);
					nextState[c.path] = finalHash;
					this.plugin.hashCache[c.path] = {
						mtime: localMtime,
						size: data.byteLength,
						hash: finalHash,
						algo: backend.id,
					};
					summary.pulled++;
				});
			}
		}
	}

	private async executePush(
		backend: StorageBackend,
		plan: SyncPlan,
		nextState: Record<string, string>,
		summary: SyncSummary,
		opts: { message?: string; staged?: Set<string> } = {}
	): Promise<void> {
		const l = messages();
		const { message, staged } = opts;

		const isStaged = (path: string) => !staged || staged.has(path);
		const stagedPushes = plan.pushes.filter((p) => isStaged(p.path));
		const stagedDeletes = plan.remoteDeletes.filter((d) => isStaged(d.path));

		// Failures that must NOT abort the whole batch — they are isolated per
		// file and surfaced at the end so the caller can retry only those on the
		// next sync. Without this, a single transient "file already exists"
		// (Gitee create-conflict) or rate limit would abort hundreds of remaining
		// uploads and force a manual re-trigger.
		const pushFailures: string[] = [];
		const deleteFailures: string[] = [];

		// Phase 2: send local changes out.
		if (this.plugin.settings.commitMode === "batch" && backend.batchCommit) {
			// Batch mode: all staged pushes and remote deletes in a single commit.
			const batchFiles: BatchFileChange[] = [];
			for (const { path, loc, rem } of stagedPushes) {
				let data = await this.vault.adapter.readBinary(loc.path);
				data = normalizeLineEndings(data);
				batchFiles.push({ path, data, remoteHash: rem?.hash });
			}
			const batchDeletes: BatchDelete[] = stagedDeletes.map(({ path, rem }) => ({
				path,
				remoteHash: rem.hash,
			}));
			if (batchFiles.length > 0 || batchDeletes.length > 0) {
				try {
					await backend.batchCommit(batchFiles, batchDeletes, message);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					throw new Error(
						l.batchCommitFailed(batchFiles.length, batchDeletes.length, msg)
					);
				}
			}
			for (const { path, loc } of stagedPushes) {
				nextState[path] = loc.hash;
				summary.pushed++;
			}
			for (const { path } of stagedDeletes) {
				summary.deletedRemote++;
			}
		} else {
			// Per-file mode: sha-guarded, so a concurrent remote change surfaces
			// as an API error instead of a silent overwrite. A single file's
			// failure is isolated — the remaining files still get transferred.
			for (const { path, loc, rem } of stagedPushes) {
				try {
					let data = await this.vault.adapter.readBinary(loc.path);
					data = normalizeLineEndings(data);
					await backend.upload(path, data, {
						hash: loc.hash,
						mtime: loc.mtime,
						remoteHash: rem?.hash,
						message,
					});
					nextState[path] = loc.hash;
					summary.pushed++;
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					pushFailures.push(l.pathFailed(path, msg));
				}
			}
			for (const { path, rem } of stagedDeletes) {
				try {
					await backend.remove(path, rem.hash);
					summary.deletedRemote++;
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					deleteFailures.push(l.pathFailed(path, msg));
				}
			}
		}

		// Persist whatever succeeded (nextState already reflects it), then
		// surface any isolated failures so the caller records them and retries
		// only those files on the next sync.
		const failures = [...pushFailures, ...deleteFailures];
		if (failures.length > 0) {
			throw new Error(l.pushPartiallyFailed(summary.pushed, summary.deletedRemote, failures));
		}
	}

	private async buildPlan(
		backend: StorageBackend,
		opts: { forPanel?: boolean } = {}
	): Promise<SyncPlan> {
		await this.plugin.gitIgnoreManager.load();
		const l = messages();
		const resolveConflictMtime = !opts.forPanel;
		const [remoteList, local] = await Promise.all([
			this.fetchManifest(backend),
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
			conflictEntries: [],
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

			// Local hashes are computed over LF-normalized content, while the
			// remote manifest stores raw git blob SHAs. A file whose only
			// difference is CRLF vs LF is textually identical and should not be
			// listed as a change in the panel or preview.
			if (loc && rem && loc.hash !== rem.hash) {
				try {
					const normalizedRemoteHash = await this.getNormalizedRemoteHash(backend, path, rem);
					if (loc.hash === normalizedRemoteHash) {
						plan.nextState[path] = loc.hash;
						plan.unchanged++;
						continue;
					}
				} catch (e) {
					// If the normalized hash cannot be fetched (e.g. transient
					// network error), fall through to the regular change logic
					// rather than hiding a potentially real change.
					console.error(
						`[gitee-sync-plus] failed to compute normalized remote hash for ${path}`,
						e
					);
				}
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
			// Both sides changed since the last sync. These are surfaced to the
			// user as conflicts instead of being silently overwritten. The
			// configured merge strategy picks the automatic winner:
			// "mtime" compares modification times (newer wins), "remote"
			// always pulls the remote version, "local" always keeps the
			// local version. A modification beats a deletion under "mtime".
			plan.conflicts++;
			const strategy = this.plugin.settings.mergeStrategy;
			let preferred: "local" | "remote" = "remote";
			let reason: string;
			if (loc && rem) {
				if (!resolveConflictMtime) {
					// In the panel we only need to know the file is conflicting;
					// the exact winner is resolved when the user runs the pull.
					preferred = "remote";
					reason = l.reasonConflictBothChanged;
					plan.pushes.push({ path, loc, rem, reason, isConflict: true });
				} else if (strategy === "remote") {
					preferred = "remote";
					reason = l.reasonConflictUseRemote;
					plan.pulls.push({ path, rem, reason, isConflict: true });
				} else if (strategy === "local") {
					preferred = "local";
					reason = l.reasonConflictUseLocal;
					plan.pushes.push({ path, loc, rem, reason, isConflict: true });
				} else {
					// "mtime": newer modification time wins. Panel mode avoids
					// expensive per-file commit-time lookups.
					const remoteMtime = await this.remoteMtime(backend, path, rem);
					if (loc.mtime >= remoteMtime) {
						preferred = "local";
						reason = l.reasonConflictLocalNewer(ts(loc.mtime), ts(remoteMtime));
						plan.pushes.push({ path, loc, rem, reason, isConflict: true });
					} else {
						preferred = "remote";
						reason = l.reasonConflictRemoteNewer(ts(remoteMtime), ts(loc.mtime));
						plan.pulls.push({ path, rem, reason, isConflict: true });
					}
				}
			} else if (loc) {
				// Remote deleted the file but local modified it.
				if (resolveConflictMtime && strategy === "remote") {
					preferred = "remote";
					reason = l.reasonConflictDeleteLocalByRemote;
					plan.localDeletes.push({ path, loc, reason, isConflict: true });
				} else {
					preferred = "local";
					reason = l.reasonConflictKeepLocal;
					plan.pushes.push({ path, loc, rem, reason, isConflict: true });
				}
			} else if (rem) {
				// Local deleted the file but remote modified it.
				if (resolveConflictMtime && strategy === "local") {
					preferred = "local";
					reason = l.reasonConflictDeleteRemoteByLocal;
					plan.remoteDeletes.push({ path, rem, reason, isConflict: true });
				} else {
					preferred = "remote";
					reason = l.reasonConflictKeepRemote;
					plan.pulls.push({ path, rem, reason, isConflict: true });
				}
			} else {
				// Unreachable: at least one side must exist to reach this branch.
				continue;
			}
			plan.conflictEntries.push({ path, loc, rem, reason, preferred });
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
				: s.backend === "gitlab"
					? `gitlab ${s.gitlabOwner}/${s.gitlabRepo}@${s.gitlabBranch}`
					: s.backend === "gitea"
						? `gitea ${s.giteaOwner}/${s.giteaRepo}@${s.giteaBranch}`
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

		// Process files in small concurrent batches to avoid sequential I/O.
		const CONCURRENCY = 10;
		const processFile = async (path: string): Promise<void> => {
			if (this.isExcluded(path)) return;
			seen.add(path);
			const stat = await adapter.stat(path);
			if (!stat || stat.type !== "file") return;
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
				let data = await adapter.readBinary(path);
				data = normalizeLineEndings(data);
				hash = await backend.hashData(data);
				cache[path] = {
					mtime: stat.mtime,
					size: stat.size,
					hash,
					algo: backend.id,
				};
			}
			result.set(path, { path, hash, mtime: stat.mtime });
		};

		for (let i = 0; i < allFiles.length; i += CONCURRENCY) {
			const batch = allFiles.slice(i, i + CONCURRENCY);
			await Promise.all(batch.map(processFile));
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

/**
 * Normalizes CRLF to LF in text files so that hash comparison is
 * line-ending-agnostic on Windows.  Binary files (containing \0 bytes)
 * are returned unchanged.
 */
function normalizeLineEndings(data: ArrayBuffer): ArrayBuffer {
	const bytes = new Uint8Array(data);
	// Fast path: no CR bytes → already normalized or binary.
	let hasCR = false;
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] === 0x0d) {
			hasCR = true;
			break;
		}
	}
	if (!hasCR) return data;
	// Detect binary: reject if any null byte in the first 1 KB.
	const sampleLen = Math.min(bytes.length, 1024);
	for (let i = 0; i < sampleLen; i++) {
		if (bytes[i] === 0) return data;
	}
	// Strip \r before \n (CRLF → LF).
	const result: number[] = [];
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] === 0x0d && i + 1 < bytes.length && bytes[i + 1] === 0x0a) continue;
		result.push(bytes[i]);
	}
	return new Uint8Array(result).buffer;
}

function ts(ms: number): string {
	return ms > 0 ? formatDateTime(new Date(ms)) : messages().unknown;
}

/** Encodes text to an LF-normalized ArrayBuffer for writing via writeLocal. */
function encodeText(text: string): ArrayBuffer {
	return new TextEncoder().encode(text.replace(/\r\n/g, "\n")).buffer;
}
