import { arrayBufferToBase64, base64ToArrayBuffer, requestUrl, RequestUrlResponse } from "obsidian";
import type { BatchDelete, BatchFileChange, RemoteEntry, StorageBackend } from "../types/backend";
import { encodePath, gitBlobSha1 } from "../utils/git-hash";
import { messages } from "../utils/i18n";

export interface GithubConfig {
	owner: string;
	repo: string;
	branch: string;
	token: string;
}

/**
 * Stores the vault as plain files in a GitHub repository via its contents/trees
 * REST API. Every upload/delete is one commit; content hashes are git blob
 * sha1, so the manifest comes for free from the recursive tree endpoint.
 *
 *   auth    — Authorization: Bearer header
 *   create  — always PUT (sha only for update)
 *   delete  — JSON body
 */
export class GitHubBackend implements StorageBackend {
	/** Bumped from "git-blob-sha1" to invalidate stale caches after adding LF normalization. */
	readonly id = "git-blob-sha1-lf";

	constructor(private cfg: GithubConfig) {}

	private get repoBase(): string {
		const owner = encodeURIComponent(this.cfg.owner);
		const repo = encodeURIComponent(this.cfg.repo);
		return `https://api.github.com/repos/${owner}/${repo}`;
	}

	private authHeaders(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.cfg.token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		};
	}

	private async request(
		method: string,
		url: string,
		body?: Record<string, unknown>
	): Promise<RequestUrlResponse> {
		const resp = await requestUrl({
			url,
			method,
			throw: false,
			headers: this.authHeaders(),
			contentType: body ? "application/json" : undefined,
			body: body ? JSON.stringify(body) : undefined,
		});
		if (resp.status >= 400) {
			const l = messages();
			let detail = "";
			try {
				detail = (resp.json as { message?: string }).message ?? "";
			} catch {
				detail = resp.text.slice(0, 200);
			}
			throw new GithubError(resp.status, l.apiFailed("github", method, resp.status, detail));
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
			if (e instanceof GithubError && (e.status === 404 || e.status === 409)) return [];
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
		// GitHub always uses PUT for both create and update; sha only needed for update.
		try {
			await this.request("PUT", url, body);
		} catch (e) {
			// A "create" that hits an already-existing file:
			//  GitHub: PUT without sha to an existing file returns 422 "'sha' wasn't
			//    supplied" — the file was NOT created, so it needs the blob sha to update.
			// We only reach here when we believed the file was new (!opts.remoteHash).
			// Fetch the existing blob sha and retry as an update so the local content
			// wins; identical content is treated as already-synced. fileSha() is the
			// real gate — if nothing exists at that path, the original error is re-thrown.
			if (!opts.remoteHash && this.isGithubStaleCreate(e)) {
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
			if (e instanceof GithubError && (e.status === 404 || e.status === 409)) return null;
			throw e;
		}
	}

	/** True when a GitHub PUT (no sha) failed because the file already exists remotely. */
	private isGithubStaleCreate(e: unknown): boolean {
		if (!(e instanceof GithubError)) return false;
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
		await this.request("DELETE", url, {
			message,
			sha: remoteHash,
			branch: this.cfg.branch,
		});
	}

	async batchCommit(files: BatchFileChange[], deletes: BatchDelete[], message?: string): Promise<void> {
		if (files.length === 0 && deletes.length === 0) return;
		await this.batchCommitGithub(files, deletes, message);
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
			if (!(e instanceof GithubError) || (e.status !== 404 && e.status !== 409)) throw e;
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

/** Verify that a token can access the given GitHub repository by fetching its branches. */
export async function testGithubToken(owner: string, repo: string, token: string): Promise<void> {
	await fetchGithubBranches(owner, repo, token);
}

/** Fetch branch list from a GitHub repository. */
export async function fetchGithubBranches(owner: string, repo: string, token: string): Promise<string[]> {
	const ownerEnc = encodeURIComponent(owner);
	const repoEnc = encodeURIComponent(repo);
	const urlBase = `https://api.github.com/repos/${ownerEnc}/${repoEnc}`;
	const url = `${urlBase}/branches?per_page=100`;
	const resp = await requestUrl({
		url,
		method: "GET",
		throw: false,
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
	if (resp.status >= 400) {
		const l = messages();
		let detail = "";
		try {
			detail = (resp.json as { message?: string }).message ?? "";
		} catch {
			detail = resp.text.slice(0, 200);
		}
		throw new GithubError(resp.status, l.apiFailed("github", "GET", resp.status, detail));
	}
	const branches = resp.json as { name: string }[];
	return branches.map((b) => b.name);
}

export class GithubError extends Error {
	constructor(public status: number, message: string) {
		super(message);
	}
}
