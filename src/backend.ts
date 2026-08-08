import type { SyncSettings } from "./settings";
import { GitHostBackend } from "./githost";
import { messages } from "./i18n";

export interface RemoteEntry {
	path: string;
	hash: string;
	/** Epoch ms; 0 when the backend cannot provide it cheaply (see statMtime). */
	mtime: number;
	size: number;
}

/** A file to create or update in a batch commit. */
export interface BatchFileChange {
	path: string;
	data: ArrayBuffer;
	/** Blob SHA of the existing remote file (undefined for new files). */
	remoteHash?: string;
}

/** A file to delete in a batch commit. */
export interface BatchDelete {
	path: string;
	/** Blob SHA of the remote file to delete. */
	remoteHash: string;
}

/**
 * Storage abstraction the sync engine runs against. Hashes are opaque to the
 * engine — it only compares them for equality — but local and remote hashes
 * must use the same algorithm, so the backend also owns hashData().
 */
export interface StorageBackend {
	/** Identifies the hash algorithm; hash caches keyed to a different id are discarded. */
	readonly id: string;
	manifest(): Promise<RemoteEntry[]>;
	download(path: string): Promise<{ data: ArrayBuffer; hash: string; mtime: number }>;
	upload(
		path: string,
		data: ArrayBuffer,
		opts: { hash: string; mtime: number; remoteHash?: string }
	): Promise<void>;
	remove(path: string, remoteHash?: string): Promise<void>;
	hashData(data: ArrayBuffer): Promise<string>;
	/** Optional precise mtime lookup, used only for conflict resolution when manifest mtime is 0. */
	statMtime?(path: string): Promise<number>;
	/**
	 * If implemented, combines multiple file changes and deletions into a single
	 * commit on the remote. When the sync engine's commitMode is "batch" and this
	 * method exists, it is used instead of per-file upload/remove calls.
	 */
	batchCommit?(files: BatchFileChange[], deletes: BatchDelete[], message?: string): Promise<void>;
}

export function createBackend(s: SyncSettings): StorageBackend {
	if (s.backend === "github") {
		if (!s.githubOwner || !s.githubRepo || !s.githubToken) {
			throw new Error(messages().missingGithubSettings);
		}
		return new GitHostBackend({
			host: "github",
			owner: s.githubOwner,
			repo: s.githubRepo,
			branch: s.githubBranch || "main",
			token: s.githubToken,
		});
	}
	if (!s.giteeOwner || !s.giteeRepo || !s.giteeToken) {
		throw new Error(messages().missingGiteeSettings);
	}
	return new GitHostBackend({
		host: "gitee",
		owner: s.giteeOwner,
		repo: s.giteeRepo,
		branch: s.giteeBranch || "master",
		token: s.giteeToken,
	});
}
