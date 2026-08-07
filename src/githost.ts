import { arrayBufferToBase64, base64ToArrayBuffer, requestUrl, RequestUrlResponse } from "obsidian";
import type { RemoteEntry, StorageBackend } from "./backend";
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
