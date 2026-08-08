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

/** Git object hash: sha1("blob <size>\0<content>") — matches the shas both hosts report in trees. */
async function gitBlobSha1(data: ArrayBuffer): Promise<string> {
	const header = new TextEncoder().encode(`blob ${data.byteLength}\0`);
	const buf = new Uint8Array(header.byteLength + data.byteLength);
	buf.set(header, 0);
	buf.set(new Uint8Array(data), header.byteLength);
	const digest = await crypto.subtle.digest("SHA-1", buf);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

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
	readonly id = "git-blob-sha1";

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
		opts: { hash: string; mtime: number; remoteHash?: string }
	): Promise<void> {
		const url = `${this.repoBase}/contents/${encodePath(path)}`;
		const body: Record<string, unknown> = {
			content: arrayBufferToBase64(data),
			message: opts.remoteHash ? messages().commitUpdate(path) : messages().commitAdd(path),
			branch: this.cfg.branch,
		};
		if (opts.remoteHash) body.sha = opts.remoteHash;
		const method = this.isGithub || opts.remoteHash ? "PUT" : "POST";
		await this.request(method, url, body);
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

	async batchCommit(files: BatchFileChange[], deletes: BatchDelete[]): Promise<void> {
		if (files.length === 0 && deletes.length === 0) return;
		if (this.isGithub) {
			await this.batchCommitGithub(files, deletes);
		} else {
			await this.batchCommitGitee(files, deletes);
		}
	}

	/**
	 * Gitee: POST /repos/{owner}/{repo}/commits — "提交多个文件变更".
	 * A single API call that creates one commit with all file changes.
	 */
	private async batchCommitGitee(files: BatchFileChange[], deletes: BatchDelete[]): Promise<void> {
		const l = messages();
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
		await this.request("POST", `${this.repoBase}/commits`, {
			branch: this.cfg.branch,
			message: l.commitBatch(files.length, deletes.length),
			actions,
		});
	}

	/**
	 * GitHub: uses the Git Database API to batch multiple file changes into one commit.
	 * Flow: get ref → get tree → create blobs → create tree → create commit → update ref.
	 * The ref update with force:false provides fast-forward protection against
	 * concurrent remote changes.
	 */
	private async batchCommitGithub(files: BatchFileChange[], deletes: BatchDelete[]): Promise<void> {
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
			message: l.commitBatch(files.length, deletes.length),
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
