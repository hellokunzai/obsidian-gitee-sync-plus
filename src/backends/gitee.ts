import { arrayBufferToBase64, base64ToArrayBuffer, requestUrl, RequestUrlResponse } from "obsidian";
import type { BatchDelete, BatchFileChange, RemoteEntry, StorageBackend } from "../types/backend";
import { encodePath, gitBlobSha1 } from "../utils/git-hash";
import { messages } from "../utils/i18n";

export interface GiteeConfig {
	owner: string;
	repo: string;
	branch: string;
	token: string;
}

/** Gitee's /commits endpoint can gateway-timeout on huge action arrays. Stay well below that. */
const GITEE_BATCH_ACTION_LIMIT = 100;

/**
 * Stores the vault as plain files in a Gitee repository via its contents/trees
 * REST API. Every upload/delete is one commit; content hashes are git blob sha1,
 * so the manifest comes for free from the recursive tree endpoint.
 *
 *   auth    — access_token in query/body
 *   create  — POST (update is PUT+sha)
 *   delete  — params in query
 */
export class GiteeBackend implements StorageBackend {
	/** Bumped from "git-blob-sha1" to invalidate stale caches after adding LF normalization. */
	readonly id = "git-blob-sha1-lf";

	constructor(private cfg: GiteeConfig) {}

	private get repoBase(): string {
		const owner = encodeURIComponent(this.cfg.owner);
		const repo = encodeURIComponent(this.cfg.repo);
		return `https://gitee.com/api/v5/repos/${owner}/${repo}`;
	}

	private withAuth(url: string): string {
		const sep = url.includes("?") ? "&" : "?";
		return `${url}${sep}access_token=${encodeURIComponent(this.cfg.token)}`;
	}

	private async request(
		method: string,
		url: string,
		body?: Record<string, unknown>
	): Promise<RequestUrlResponse> {
		const payload = body ? { access_token: this.cfg.token, ...body } : undefined;
		const resp = await requestUrl({
			url: this.withAuth(url),
			method,
			throw: false,
			headers: {},
			contentType: payload ? "application/json" : undefined,
			body: payload ? JSON.stringify(payload) : undefined,
		});
		if (resp.status >= 400) {
			const l = messages();
			let detail = "";
			try {
				detail = (resp.json as { message?: string }).message ?? "";
			} catch {
				detail = resp.text.slice(0, 200);
			}
			throw new GiteeError(resp.status, l.apiFailed("gitee", method, resp.status, detail));
		}
		return resp;
	}

	async manifest(): Promise<RemoteEntry[]> {
		let resp: RequestUrlResponse;
		try {
			resp = await this.request(
				"GET",
				`${this.repoBase}/git/trees/${encodeURIComponent(this.cfg.branch)}?recursive=1`
			);
		} catch (e) {
			// A brand-new repo has no branch yet — treat as empty, first push initializes it.
			if (e instanceof GiteeError && (e.status === 404 || e.status === 409)) return [];
			throw e;
		}
		const body = resp.json as {
			truncated?: boolean;
			tree: { path: string; type: string; sha: string; size?: number }[];
		};
		if (body.truncated) {
			// An incomplete manifest would be read as mass remote deletions — refuse to sync.
			throw new Error(messages().remoteTreeTruncated);
		}
		return body.tree
			.filter((t) => t.type === "blob")
			.map((t) => ({ path: t.path, hash: t.sha, mtime: 0, size: t.size ?? 0 }));
	}

	async download(path: string): Promise<{ data: ArrayBuffer; hash: string; mtime: number }> {
		const resp = await this.request(
			"GET",
			`${this.repoBase}/contents/${encodePath(path)}?ref=${encodeURIComponent(this.cfg.branch)}`
		);
		const file = resp.json as { content?: string; sha: string };
		let base64 = (file.content ?? "").replace(/\s/g, "");
		if (!base64 && file.sha) {
			// Contents API omits bodies for large files; fall back to the blobs endpoint.
			const blob = await this.request("GET", `${this.repoBase}/git/blobs/${file.sha}`);
			base64 = ((blob.json as { content?: string }).content ?? "").replace(/\s/g, "");
		}
		return { data: base64ToArrayBuffer(base64), hash: file.sha, mtime: 0 };
	}

	async upload(
		path: string,
		data: ArrayBuffer,
		opts: { hash: string; mtime: number; remoteHash?: string; message?: string }
	): Promise<void> {
		const url = `${this.repoBase}/contents/${encodePath(path)}`;
		const fallbackMessage = opts.remoteHash
			? messages().commitUpdate(path)
			: messages().commitAdd(path);
		const body: Record<string, unknown> = {
			content: arrayBufferToBase64(data),
			message: opts.message && opts.message.trim() ? opts.message.trim() : fallbackMessage,
			branch: this.cfg.branch,
		};
		if (opts.remoteHash) body.sha = opts.remoteHash;
		const method = opts.remoteHash ? "PUT" : "POST";
		try {
			await this.request(method, url, body);
		} catch (e) {
			// A "create" that hits an already-existing file:
			//  - Gitee: POST returns "already exists" (the file may already be created).
			// We only reach here when we believed the file was new (!opts.remoteHash).
			// Fetch the existing blob sha and retry as an update so the local content
			// wins; identical content is treated as already-synced. fileSha() is the
			// real gate — if nothing exists at that path we re-throw the original error.
			if (!opts.remoteHash && this.isCreateConflict(e)) {
				const existingSha = await this.fileSha(path);
				if (existingSha === opts.hash) return; // remote already holds identical content
				if (existingSha) {
					await this.request("PUT", url, { ...body, sha: existingSha });
					return;
				}
				// No remote file but the create still errored — surface the original.
			}
			throw e;
		}
	}

	/** Returns the current blob SHA of a remote file, or null if it does not exist. */
	private async fileSha(path: string): Promise<string | null> {
		try {
			const resp = await this.request(
				"GET",
				`${this.repoBase}/contents/${encodePath(path)}?ref=${encodeURIComponent(this.cfg.branch)}`
			);
			return (resp.json as { sha?: string }).sha ?? null;
		} catch (e) {
			if (e instanceof GiteeError && (e.status === 404 || e.status === 409)) return null;
			throw e;
		}
	}

	/** True when a create (POST) failed because the target already exists on the host. */
	private isCreateConflict(e: unknown): boolean {
		if (!(e instanceof GiteeError)) return false;
		if (/exist|已存在|duplicate|conflict|冲突/i.test(e.message)) return true;
		// Gitee also reports this with a 409 even when the message text varies.
		return e.status === 409;
	}

	/** True for gateway/proxy errors where retrying with smaller requests may help. */
	private isGatewayError(e: unknown): boolean {
		return e instanceof GiteeError && (e.status === 502 || e.status === 503 || e.status === 504);
	}

	/**
	 * True when Gitee's batch /commits endpoint returns a 400 because a single
	 * "create" action could not be applied (e.g. "文件新建失败"). The whole chunk
	 * is rejected, but replaying the same change per-file either resolves the
	 * conflict idempotently (file already exists with identical content) or
	 * surfaces the exact offending path instead of failing thousands of files.
	 */
	private isGiteeBatchCreateFailure(e: unknown): boolean {
		return e instanceof GiteeError && e.status === 400 && /文件新建失败|新建失败/.test(e.message);
	}

	async remove(path: string, remoteHash?: string): Promise<void> {
		if (!remoteHash) throw new Error(messages().deleteNeedsSha(path));
		const url = `${this.repoBase}/contents/${encodePath(path)}`;
		const message = messages().commitDelete(path);
		await this.request(
			"DELETE",
			`${url}?sha=${encodeURIComponent(remoteHash)}` +
				`&message=${encodeURIComponent(message)}` +
				`&branch=${encodeURIComponent(this.cfg.branch)}`
		);
	}

	async batchCommit(files: BatchFileChange[], deletes: BatchDelete[], message?: string): Promise<void> {
		if (files.length === 0 && deletes.length === 0) return;
		const l = messages();
		const commitMessage =
			message && message.trim() ? message.trim() : l.commitBatch(files.length, deletes.length);
		const changes: (BatchFileChange | BatchDelete)[] = [...files, ...deletes];
		const chunks = this.chunkArray(changes, GITEE_BATCH_ACTION_LIMIT);
		for (const chunk of chunks) {
			const chunkFiles = chunk.filter((c): c is BatchFileChange => "data" in c);
			const chunkDeletes = chunk.filter((c): c is BatchDelete => !("data" in c));
			await this.batchCommitGiteeChunk(chunkFiles, chunkDeletes, commitMessage);
		}
	}

	private async batchCommitGiteeChunk(
		files: BatchFileChange[],
		deletes: BatchDelete[],
		commitMessage: string
	): Promise<void> {
		const actions: Record<string, unknown>[] = [];
		for (const f of files) {
			actions.push({
				action: f.remoteHash ? "update" : "create",
				path: f.path,
				content: arrayBufferToBase64(f.data),
				encoding: "base64",
			});
		}
		for (const d of deletes) {
			actions.push({ action: "delete", path: d.path });
		}
		if (actions.length === 0) return;
		try {
			await this.request("POST", `${this.repoBase}/commits`, {
				branch: this.cfg.branch,
				message: commitMessage,
				actions,
			});
		} catch (e) {
			// Gitee rejects the ENTIRE chunk when a single "create" action fails
			// (already-existing file, "文件新建失败", etc.) or when the gateway
			// itself times out. Replay only this chunk as individual file commits
			// — the per-file upload/remove path already resolves create conflicts
			// idempotently and makes much smaller requests, so it recovers from
			// all of these cases without losing local data.
			if (this.isCreateConflict(e) || this.isGatewayError(e) || this.isGiteeBatchCreateFailure(e)) {
				await this.batchCommitFallback(files, deletes, commitMessage);
				return;
			}
			throw e;
		}
	}

	/**
	 * Gitee batch-commit fallback: replay each change as its own commit. Used
	 * only after a batch fails on a create conflict. Reuses the per-file
	 * upload/remove logic, which already resolves create conflicts idempotently.
	 */
	private async batchCommitFallback(
		files: BatchFileChange[],
		deletes: BatchDelete[],
		message: string
	): Promise<void> {
		for (const f of files) {
			await this.upload(f.path, f.data, {
				hash: await gitBlobSha1(f.data),
				mtime: 0,
				remoteHash: f.remoteHash,
				message,
			});
		}
		for (const d of deletes) {
			await this.remove(d.path, d.remoteHash);
		}
	}

	private chunkArray<T>(arr: T[], size: number): T[][] {
		const chunks: T[][] = [];
		for (let i = 0; i < arr.length; i += size) {
			chunks.push(arr.slice(i, i + size));
		}
		return chunks;
	}

	hashData(data: ArrayBuffer): Promise<string> {
		return gitBlobSha1(data);
	}

	/** Last commit time touching the path — only queried on real conflicts. */
	async statMtime(path: string): Promise<number> {
		const resp = await this.request(
			"GET",
			`${this.repoBase}/commits?sha=${encodeURIComponent(this.cfg.branch)}` +
				`&path=${encodePath(path)}&page=1&per_page=1`
		);
		const commits = resp.json as { commit?: { committer?: { date?: string } } }[];
		const date = commits[0]?.commit?.committer?.date;
		return date ? Date.parse(date) : 0;
	}
}

/** Verify that a token can access the given Gitee repository by fetching its branches. */
export async function testGiteeToken(owner: string, repo: string, token: string): Promise<void> {
	await fetchGiteeBranches(owner, repo, token);
}

/** Fetch branch list from a Gitee repository. */
export async function fetchGiteeBranches(owner: string, repo: string, token: string): Promise<string[]> {
	const ownerEnc = encodeURIComponent(owner);
	const repoEnc = encodeURIComponent(repo);
	const urlBase = `https://gitee.com/api/v5/repos/${ownerEnc}/${repoEnc}`;
	const sep = urlBase.includes("?") ? "&" : "?";
	const url = `${urlBase}/branches${sep}access_token=${encodeURIComponent(token)}`;
	const resp = await requestUrl({
		url,
		method: "GET",
		throw: false,
		headers: {},
	});
	if (resp.status >= 400) {
		const l = messages();
		let detail = "";
		try {
			detail = (resp.json as { message?: string }).message ?? "";
		} catch {
			detail = resp.text.slice(0, 200);
		}
		throw new GiteeError(resp.status, l.apiFailed("gitee", "GET", resp.status, detail));
	}
	const branches = resp.json as { name: string }[];
	return branches.map((b) => b.name);
}

export class GiteeError extends Error {
	constructor(public status: number, message: string) {
		super(message);
	}
}
