import { arrayBufferToBase64, base64ToArrayBuffer, requestUrl, RequestUrlResponse } from "obsidian";
import type { BatchDelete, BatchFileChange, RemoteEntry, StorageBackend } from "./backend";
import { messages } from "./i18n";

export type GitHost = "gitee" | "github";

export interface GitHostConfig {
	host: GitHost;
	owner: string;
	repo: string;
	branch: string;
	token: string;
}

/**
 * Pure-JS SHA-1 (RFC 3174), matching the hash Git stores for "blob" objects.
 *
 * Implemented locally instead of `crypto.subtle.digest` so the plugin behaves
 * identically on desktop and mobile. `crypto.subtle` is only available in
 * secure contexts and may be undefined inside Obsidian's mobile webview, which
 * would otherwise break every sync. Files are kept well under the limit where
 * the 32-bit bit-length encoding below is exact (the plugin caps at ~50 MB).
 */
function sha1(bytes: Uint8Array): string {
	const blockSize = 64;
	const msgLen = bytes.length;
	// Padded length: original + 0x80 delimiter + 8-byte big-endian bit length, rounded up to 64.
	const totalLen = (msgLen + 1 + 8 + blockSize - 1) & ~(blockSize - 1);
	const padded = new Uint8Array(totalLen);
	padded.set(bytes);
	padded[msgLen] = 0x80;
	// 64-bit big-endian bit length (msgLen * 8) into the final 8 bytes.
	const bitLen = msgLen * 8;
	const hi = Math.floor(bitLen / 0x100000000);
	const lo = bitLen >>> 0;
	padded[totalLen - 8] = (hi >>> 24) & 0xff;
	padded[totalLen - 7] = (hi >>> 16) & 0xff;
	padded[totalLen - 6] = (hi >>> 8) & 0xff;
	padded[totalLen - 5] = hi & 0xff;
	padded[totalLen - 4] = (lo >>> 24) & 0xff;
	padded[totalLen - 3] = (lo >>> 16) & 0xff;
	padded[totalLen - 2] = (lo >>> 8) & 0xff;
	padded[totalLen - 1] = lo & 0xff;

	let h0 = 0x67452301;
	let h1 = 0xefcdab89;
	let h2 = 0x98badcfe;
	let h3 = 0x10325476;
	let h4 = 0xc3d2e1f0;

	const w = new Uint32Array(80);
	for (let off = 0; off < totalLen; off += blockSize) {
		for (let i = 0; i < 16; i++) {
			const j = off + i * 4;
			w[i] = ((padded[j] << 24) | (padded[j + 1] << 16) | (padded[j + 2] << 8) | padded[j + 3]) >>> 0;
		}
		for (let i = 16; i < 80; i++) {
			const n = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
			w[i] = ((n << 1) | (n >>> 31)) >>> 0;
		}
		let a = h0;
		let b = h1;
		let c = h2;
		let d = h3;
		let e = h4;
		for (let i = 0; i < 80; i++) {
			let f: number;
			let k: number;
			if (i < 20) {
				f = (b & c) | (~b & d);
				k = 0x5a827999;
			} else if (i < 40) {
				f = b ^ c ^ d;
				k = 0x6ed9eba1;
			} else if (i < 60) {
				f = (b & c) | (b & d) | (c & d);
				k = 0x8f1bbcdc;
			} else {
				f = b ^ c ^ d;
				k = 0xca62c1d6;
			}
			const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
			e = d;
			d = c;
			c = ((b << 30) | (b >>> 2)) >>> 0;
			b = a;
			a = temp;
		}
		h0 = (h0 + a) >>> 0;
		h1 = (h1 + b) >>> 0;
		h2 = (h2 + c) >>> 0;
		h3 = (h3 + d) >>> 0;
		h4 = (h4 + e) >>> 0;
	}
	const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
	return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4);
}

/** Git object hash: sha1("blob <size>\0<content>") — matches the shas both hosts report in trees. */
async function gitBlobSha1(data: ArrayBuffer): Promise<string> {
	const header = new TextEncoder().encode(`blob ${data.byteLength}\0`);
	const buf = new Uint8Array(header.byteLength + data.byteLength);
	buf.set(header, 0);
	buf.set(new Uint8Array(data), header.byteLength);
	return sha1(buf);
}

function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

/** Gitee's /commits endpoint can gateway-timeout on huge action arrays. Stay well below that. */
const GITEE_BATCH_ACTION_LIMIT = 100;

/**
 * Stores the vault as plain files in a Gitee or GitHub repository via their
 * (near-identical) contents/trees REST APIs. Every upload/delete is one
 * commit; content hashes are git blob sha1, so the manifest comes for free
 * from the recursive tree endpoint.
 *
 * Host differences handled here:
 *   auth    — Gitee: access_token in query/body; GitHub: Authorization header
 *   create  — Gitee: POST (update is PUT+sha); GitHub: always PUT (sha only for update)
 *   delete  — Gitee: params in query; GitHub: JSON body
 */
export class GitHostBackend implements StorageBackend {
	/** Bumped from "git-blob-sha1" to invalidate stale caches after adding LF normalization. */
	readonly id = "git-blob-sha1-lf";

	constructor(private cfg: GitHostConfig) {}

	private get repoBase(): string {
		const owner = encodeURIComponent(this.cfg.owner);
		const repo = encodeURIComponent(this.cfg.repo);
		return this.cfg.host === "github"
			? `https://api.github.com/repos/${owner}/${repo}`
			: `https://gitee.com/api/v5/repos/${owner}/${repo}`;
	}

	private get isGithub(): boolean {
		return this.cfg.host === "github";
	}

	private authHeaders(): Record<string, string> {
		return this.isGithub
			? {
					Authorization: `Bearer ${this.cfg.token}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
			  }
			: {};
	}

	private withAuth(url: string): string {
		if (this.isGithub) return url;
		const sep = url.includes("?") ? "&" : "?";
		return `${url}${sep}access_token=${encodeURIComponent(this.cfg.token)}`;
	}

	private async request(
		method: string,
		url: string,
		body?: Record<string, unknown>
	): Promise<RequestUrlResponse> {
		const payload = body && !this.isGithub ? { access_token: this.cfg.token, ...body } : body;
		const resp = await requestUrl({
			url: this.withAuth(url),
			method,
			throw: false,
			headers: this.authHeaders(),
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
			throw new GitHostError(resp.status, l.apiFailed(this.cfg.host, method, resp.status, detail));
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
			if (e instanceof GitHostError && (e.status === 404 || e.status === 409)) return [];
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
		const method = this.isGithub || opts.remoteHash ? "PUT" : "POST";
		try {
			await this.request(method, url, body);
		} catch (e) {
			// A "create" that hits an already-existing file:
			//  - Gitee: POST returns "already exists" (the file may already be created).
			//  - GitHub: PUT without sha to an existing file returns 422 "'sha' wasn't
			//    supplied" — the file was NOT created, so it needs the blob sha to update.
			// We only reach here when we believed the file was new (!opts.remoteHash).
			// Fetch the existing blob sha and retry as an update so the local content
			// wins; identical content is treated as already-synced. fileSha() is the
			// real gate — if nothing exists at that path we re-throw the original error.
			if (
				!opts.remoteHash &&
				(this.isGithub ? this.isGithubStaleCreate(e) : this.isCreateConflict(e))
			) {
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
			if (e instanceof GitHostError && (e.status === 404 || e.status === 409)) return null;
			throw e;
		}
	}

	/** True when a create (POST) failed because the target already exists on the host. */
	private isCreateConflict(e: unknown): boolean {
		if (!(e instanceof GitHostError)) return false;
		if (/exist|已存在|duplicate|conflict|冲突/i.test(e.message)) return true;
		// Gitee also reports this with a 409 even when the message text varies.
		return e.status === 409;
	}

	/** True for gateway/proxy errors where retrying with smaller requests may help. */
	private isGatewayError(e: unknown): boolean {
		return e instanceof GitHostError && (e.status === 502 || e.status === 503 || e.status === 504);
	}

	/**
	 * True when Gitee's batch /commits endpoint returns a 400 because a single
	 * "create" action could not be applied (e.g. "文件新建失败"). The whole chunk
	 * is rejected, but replaying the same change per-file either resolves the
	 * conflict idempotently (file already exists with identical content) or
	 * surfaces the exact offending path instead of failing thousands of files.
	 */
	private isGiteeBatchCreateFailure(e: unknown): boolean {
		return e instanceof GitHostError && e.status === 400 && /文件新建失败|新建失败/.test(e.message);
	}

	/** True when a GitHub PUT (no sha) failed because the file already exists remotely. */
	private isGithubStaleCreate(e: unknown): boolean {
		if (!(e instanceof GitHostError)) return false;
		// GitHub returns 422 with "'sha' wasn't supplied" (or "already exists")
		// when a create hits an existing file. fileSha() further below is the real
		// gate: if nothing exists at that path, the original error is re-thrown, so
		// unrelated 422s (protected branch, invalid content) are never masked.
		return e.status === 422 && /"sha".*suppl|already exist/i.test(e.message);
	}

	async remove(path: string, remoteHash?: string): Promise<void> {
		if (!remoteHash) throw new Error(messages().deleteNeedsSha(path));
		const url = `${this.repoBase}/contents/${encodePath(path)}`;
		const message = messages().commitDelete(path);
		if (this.isGithub) {
			await this.request("DELETE", url, {
				message,
				sha: remoteHash,
				branch: this.cfg.branch,
			});
		} else {
			await this.request(
				"DELETE",
				`${url}?sha=${encodeURIComponent(remoteHash)}` +
					`&message=${encodeURIComponent(message)}` +
					`&branch=${encodeURIComponent(this.cfg.branch)}`
			);
		}
	}

	async batchCommit(files: BatchFileChange[], deletes: BatchDelete[], message?: string): Promise<void> {
		if (files.length === 0 && deletes.length === 0) return;
		if (this.isGithub) {
			await this.batchCommitGithub(files, deletes, message);
		} else {
			await this.batchCommitGitee(files, deletes, message);
		}
	}

	/**
	 * Gitee: POST /repos/{owner}/{repo}/commits — "提交多个文件变更".
	 *
	 * Split large action arrays into chunks: Gitee's gateway/proxy times out
	 * (502/504) when too many actions are submitted at once. Each chunk gets its
	 * own commit. If a chunk still fails on a create conflict or gateway error,
	 * fall back to per-file commits for that chunk only.
	 */
	private async batchCommitGitee(files: BatchFileChange[], deletes: BatchDelete[], message?: string): Promise<void> {
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
			if (
				this.isCreateConflict(e) ||
				this.isGatewayError(e) ||
				this.isGiteeBatchCreateFailure(e)
			) {
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

	/**
	 * GitHub: uses the Git Database API to batch multiple file changes into one commit.
	 * Flow: get ref → get tree → create blobs → create tree → create commit → update ref.
	 * The ref update with force:false provides fast-forward protection against
	 * concurrent remote changes.
	 */
	private async batchCommitGithub(files: BatchFileChange[], deletes: BatchDelete[], message?: string): Promise<void> {
		const l = messages();

		// 1. Get current commit SHA and tree SHA (skip if branch doesn't exist yet)
		let parentSha: string | undefined;
		let baseTreeSha: string | undefined;
		try {
			const refResp = await this.request(
				"GET",
				`${this.repoBase}/git/refs/heads/${encodeURIComponent(this.cfg.branch)}`
			);
			parentSha = (refResp.json as { object: { sha: string } }).object.sha;
			const commitResp = await this.request("GET", `${this.repoBase}/git/commits/${parentSha}`);
			baseTreeSha = (commitResp.json as { tree: { sha: string } }).tree.sha;
		} catch (e) {
			// New repo with no commits — proceed without a parent
			if (!(e instanceof GitHostError) || (e.status !== 404 && e.status !== 409)) throw e;
		}

		// 2. Create blobs for each file and build tree entries
		const treeEntries: Record<string, unknown>[] = [];
		for (const f of files) {
			const blobResp = await this.request("POST", `${this.repoBase}/git/blobs`, {
				content: arrayBufferToBase64(f.data),
				encoding: "base64",
			});
			treeEntries.push({
				path: f.path,
				mode: "100644",
				type: "blob",
				sha: (blobResp.json as { sha: string }).sha,
			});
		}
		// 3. Add delete entries (sha: null removes the path from the base tree)
		for (const d of deletes) {
			treeEntries.push({
				path: d.path,
				mode: "100644",
				type: "blob",
				sha: null,
			});
		}

		// 4. Create new tree (based on current tree if it exists)
		const treeBody: Record<string, unknown> = { tree: treeEntries };
		if (baseTreeSha) treeBody.base_tree = baseTreeSha;
		const treeResp = await this.request("POST", `${this.repoBase}/git/trees`, treeBody);
		const newTreeSha = (treeResp.json as { sha: string }).sha;

		// 5. Create commit
		const commitBody: Record<string, unknown> = {
			message: message && message.trim() ? message.trim() : l.commitBatch(files.length, deletes.length),
			tree: newTreeSha,
		};
		if (parentSha) commitBody.parents = [parentSha];
		const newCommitResp = await this.request("POST", `${this.repoBase}/git/commits`, commitBody);
		const newCommitSha = (newCommitResp.json as { sha: string }).sha;

		// 6. Update or create the branch ref
		if (parentSha) {
			// Existing branch: update ref with fast-forward protection
			await this.request(
				"PATCH",
				`${this.repoBase}/git/refs/heads/${encodeURIComponent(this.cfg.branch)}`,
				{ sha: newCommitSha, force: false }
			);
		} else {
			// New branch: create the ref
			await this.request("POST", `${this.repoBase}/git/refs`, {
				ref: `refs/heads/${this.cfg.branch}`,
				sha: newCommitSha,
			});
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

/** Verify that a token can access the given repository by fetching its branches. */
export async function testToken(host: GitHost, owner: string, repo: string, token: string): Promise<void> {
	await fetchBranches(host, owner, repo, token);
}

/** Fetch branch list from a Gitee or GitHub repository. */
export async function fetchBranches(
	host: GitHost,
	owner: string,
	repo: string,
	token: string
): Promise<string[]> {
	const ownerEnc = encodeURIComponent(owner);
	const repoEnc = encodeURIComponent(repo);
	const urlBase =
		host === "github"
			? `https://api.github.com/repos/${ownerEnc}/${repoEnc}`
			: `https://gitee.com/api/v5/repos/${ownerEnc}/${repoEnc}`;
	const isGithub = host === "github";
	const sep = urlBase.includes("?") ? "&" : "?";
	const url = isGithub
		? `${urlBase}/branches?per_page=100`
		: `${urlBase}/branches${sep}access_token=${encodeURIComponent(token)}`;
	const resp = await requestUrl({
		url,
		method: "GET",
		throw: false,
		headers: isGithub
			? {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
			  }
			: {},
	});
	if (resp.status >= 400) {
		const l = messages();
		let detail = "";
		try {
			detail = (resp.json as { message?: string }).message ?? "";
		} catch {
			detail = resp.text.slice(0, 200);
		}
		throw new GitHostError(resp.status, l.apiFailed(host, "GET", resp.status, detail));
	}
	const branches = resp.json as { name: string }[];
	return branches.map((b) => b.name);
}

class GitHostError extends Error {
	constructor(public status: number, message: string) {
		super(message);
	}
}
