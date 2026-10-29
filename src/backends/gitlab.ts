import { arrayBufferToBase64, base64ToArrayBuffer, requestUrl, RequestUrlResponse } from "obsidian";
import type { BatchDelete, BatchFileChange, RemoteEntry, StorageBackend } from "../types/backend";
import { gitBlobSha1 } from "../utils/git-hash";
import { messages } from "../utils/i18n";

export interface GitLabConfig {
	owner: string;
	repo: string;
	branch: string;
	token: string;
	/** Base URL of the GitLab instance. Defaults to https://gitlab.com. */
	gitlabUrl: string;
}

export const DEFAULT_GITLAB_URL = "https://gitlab.com";

/**
 * Stores the vault as plain files in a GitLab repository via the REST v4 API.
 *
 *   base      — ${gitlabUrl}/api/v4
 *   project   — encodeURIComponent(`${owner}/${repo}`)  (owner%2Frepo)
 *   auth      — PRIVATE-TOKEN header
 *   download  — GET  /projects/:id/repository/files/:file_path?ref=:branch
 *   create    — POST /projects/:id/repository/files/:file_path?branch=:branch
 *   update    — PUT  /projects/:id/repository/files/:file_path?branch=:branch
 *   delete    — DELETE /projects/:id/repository/files/:file_path?branch=:branch
 *   batch     — POST /projects/:id/repository/commits
 */
export class GitLabBackend implements StorageBackend {
	/** Bumped from "git-blob-sha1" to invalidate stale caches after adding LF normalization. */
	readonly id = "git-blob-sha1-lf";

	constructor(private cfg: GitLabConfig) {}

	private get baseUrl(): string {
		const url = (this.cfg.gitlabUrl || DEFAULT_GITLAB_URL).replace(/\/+$/, "");
		return `${url}/api/v4`;
	}

	private get projectId(): string {
		return encodeURIComponent(`${this.cfg.owner}/${this.cfg.repo}`);
	}

	private get projectBase(): string {
		return `${this.baseUrl}/projects/${this.projectId}`;
	}

	private authHeaders(): Record<string, string> {
		return { "PRIVATE-TOKEN": this.cfg.token };
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
			let message = l.apiFailed("gitlab", method, resp.status, detail);
			// A 403 on a repository endpoint almost always means the token lacks
			// the read_repository (or api) scope — GET /projects/:id only needs
			// read_api, which is why the connection test can pass while sync fails.
			if (resp.status === 403) message += " " + l.gitlabForbiddenHint;
			throw new GitLabError(resp.status, message);
		}
		return resp;
	}

	async manifest(): Promise<RemoteEntry[]> {
		const entries: RemoteEntry[] = [];
		let page = 1;
		// GitLab paginates the tree; follow X-Next-Page until it disappears.
		while (true) {
			let resp: RequestUrlResponse;
			try {
				resp = await this.request(
					"GET",
					`${this.projectBase}/repository/tree?recursive=true&per_page=100&page=${page}`
				);
			} catch (e) {
				// An empty repository (no commits / no default branch yet) has no
				// tree. GitLab.com returns 404; some self-managed instances such as
				// JihuLab return 403. Either way there are no files to sync yet, so
				// treat it as an empty manifest and let the first sync push them.
				if (e instanceof GitLabError && (e.status === 404 || (e.status === 403 && page === 1))) {
					if (e.status === 403) {
						console.warn(
							"[gitee-sync-plus] GitLab repository/tree returned 403; treating the repository as empty. " +
								"If the repository actually contains files, the access token is missing the read_repository (or api) scope."
						);
					}
					return entries;
				}
				throw e;
			}
			const items = resp.json as { type: string; path: string; id: string }[];
			for (const item of items) {
				if (item.type === "blob") {
					entries.push({ path: item.path, hash: item.id, mtime: 0, size: 0 });
				}
			}
			const next = resp.headers?.["X-Next-Page"];
			if (!next) break;
			const parsed = Number(next);
			if (!Number.isFinite(parsed) || parsed <= page) break;
			page = parsed;
		}
		return entries;
	}

	async download(path: string): Promise<{ data: ArrayBuffer; hash: string; mtime: number }> {
		const fp = encodeURIComponent(path);
		const resp = await this.request(
			"GET",
			`${this.projectBase}/repository/files/${fp}?ref=${encodeURIComponent(this.cfg.branch)}`
		);
		const file = resp.json as { content?: string; blob_id?: string; id?: string };
		const base64 = (file.content ?? "").replace(/\s/g, "");
		return {
			data: base64ToArrayBuffer(base64),
			hash: file.blob_id ?? file.id ?? "",
			mtime: 0,
		};
	}

	async upload(
		path: string,
		data: ArrayBuffer,
		opts: { hash: string; mtime: number; remoteHash?: string; message?: string }
	): Promise<void> {
		const fp = encodeURIComponent(path);
		const url = `${this.projectBase}/repository/files/${fp}?branch=${encodeURIComponent(this.cfg.branch)}`;
		const commitMessage =
			opts.message && opts.message.trim()
				? opts.message.trim()
				: opts.remoteHash
					? messages().commitUpdate(path)
					: messages().commitAdd(path);
		const body: Record<string, unknown> = {
			branch: this.cfg.branch,
			content: arrayBufferToBase64(data),
			encoding: "base64",
			commit_message: commitMessage,
		};
		if (opts.remoteHash) {
			// Existing file: update in place.
			await this.request("PUT", url, body);
			return;
		}
		// Existence check: PUT if the file already exists, else POST to create.
		let exists = false;
		try {
			await this.request(
				"GET",
				`${this.projectBase}/repository/files/${fp}?ref=${encodeURIComponent(this.cfg.branch)}`
			);
			exists = true;
		} catch (e) {
			if (e instanceof GitLabError && e.status === 404) {
				exists = false;
			} else {
				throw e;
			}
		}
		await this.request(exists ? "PUT" : "POST", url, body);
	}

	async remove(path: string, _remoteHash?: string): Promise<void> {
		const fp = encodeURIComponent(path);
		const url = `${this.projectBase}/repository/files/${fp}?branch=${encodeURIComponent(this.cfg.branch)}`;
		await this.request("DELETE", url, {
			branch: this.cfg.branch,
			commit_message: messages().commitDelete(path),
		});
	}

	async batchCommit(files: BatchFileChange[], deletes: BatchDelete[], message?: string): Promise<void> {
		if (files.length === 0 && deletes.length === 0) return;
		const l = messages();
		const commitMessage =
			message && message.trim()
				? message.trim()
				: l.commitBatch(files.length, deletes.length);
		const actions: Record<string, unknown>[] = [];
		for (const f of files) {
			actions.push({
				action: f.remoteHash ? "update" : "create",
				file_path: f.path,
				content: arrayBufferToBase64(f.data),
				encoding: "base64",
			});
		}
		for (const d of deletes) {
			actions.push({ action: "delete", file_path: d.path });
		}
		await this.request("POST", `${this.projectBase}/repository/commits`, {
			branch: this.cfg.branch,
			commit_message: commitMessage,
			actions,
		});
	}

	hashData(data: ArrayBuffer): Promise<string> {
		return gitBlobSha1(data);
	}

	/** Last commit time touching the path — only queried on real conflicts. */
	async statMtime(path: string): Promise<number> {
		const fp = encodeURIComponent(path);
		const resp = await this.request(
			"GET",
			`${this.projectBase}/repository/commits?path=${fp}&ref=${encodeURIComponent(this.cfg.branch)}&per_page=1`
		);
		const commits = resp.json as { committed_date?: string }[];
		const date = commits[0]?.committed_date;
		return date ? Date.parse(date) : 0;
	}
}

/** Verify that a token can actually sync: reach the project AND read its repository. */
export async function testGitLabToken(owner: string, repo: string, token: string, gitlabUrl = DEFAULT_GITLAB_URL): Promise<void> {
	const url = (gitlabUrl || DEFAULT_GITLAB_URL).replace(/\/+$/, "");
	const projectId = encodeURIComponent(`${owner}/${repo}`);
	const l = messages();
	const detailOf = (r: RequestUrlResponse): string => {
		try {
			return (r.json as { message?: string }).message ?? "";
		} catch {
			return r.text.slice(0, 200);
		}
	};
	// 1. The project must be reachable (needs read_api or api).
	const project = await requestUrl({
		url: `${url}/api/v4/projects/${projectId}`,
		method: "GET",
		throw: false,
		headers: { "PRIVATE-TOKEN": token },
	});
	if (project.status >= 400) {
		throw new GitLabError(project.status, l.apiFailed("gitlab", "GET", project.status, detailOf(project)));
	}
	// 2. The repository content must be readable (needs read_repository or api).
	//    An empty repo returns 404 (or 403 on some instances) — both mean "no
	//    files yet" and are fine. A 403 on a non-empty repo means the token
	//    lacks the read_repository / api scope, which would break the sync.
	const tree = await requestUrl({
		url: `${url}/api/v4/projects/${projectId}/repository/tree?per_page=1`,
		method: "GET",
		throw: false,
		headers: { "PRIVATE-TOKEN": token },
	});
	if (tree.status === 403) {
		throw new GitLabError(403, l.gitlabTestScopeError);
	}
	// 200 or 404 → the token can sync.
}

/** Fetch branch list from a GitLab project. */
export async function fetchGitLabBranches(owner: string, repo: string, token: string, gitlabUrl = DEFAULT_GITLAB_URL): Promise<string[]> {
	const url = (gitlabUrl || DEFAULT_GITLAB_URL).replace(/\/+$/, "");
	const projectId = encodeURIComponent(`${owner}/${repo}`);
	const resp = await requestUrl({
		url: `${url}/api/v4/projects/${projectId}/repository/branches?per_page=100`,
		method: "GET",
		throw: false,
		headers: { "PRIVATE-TOKEN": token },
	});
	if (resp.status >= 400) {
		const l = messages();
		let detail = "";
		try {
			detail = (resp.json as { message?: string }).message ?? "";
		} catch {
			detail = resp.text.slice(0, 200);
		}
		throw new GitLabError(resp.status, l.apiFailed("gitlab", "GET", resp.status, detail));
	}
	const branches = resp.json as { name: string }[];
	return branches.map((b) => b.name);
}

export class GitLabError extends Error {
	constructor(public status: number, message: string) {
		super(message);
	}
}
