import type { SyncSettings } from "../types/settings";
import type { StorageBackend } from "../types/backend";
import { messages } from "../utils/i18n";
import { GiteeBackend } from "./gitee";
import { GitHubBackend } from "./github";
import { DEFAULT_GITLAB_URL, GitLabBackend } from "./gitlab";

export function createBackend(s: SyncSettings): StorageBackend {
	if (s.backend === "gitlab") {
		if (!s.gitlabOwner || !s.gitlabRepo || !s.gitlabToken) {
			throw new Error(messages().missingGitlabSettings);
		}
		return new GitLabBackend({
			owner: s.gitlabOwner,
			repo: s.gitlabRepo,
			branch: s.gitlabBranch || "main",
			token: s.gitlabToken,
			gitlabUrl: s.gitlabUrl || DEFAULT_GITLAB_URL,
		});
	}
	if (s.backend === "github") {
		if (!s.githubOwner || !s.githubRepo || !s.githubToken) {
			throw new Error(messages().missingGithubSettings);
		}
		return new GitHubBackend({
			owner: s.githubOwner,
			repo: s.githubRepo,
			branch: s.githubBranch || "main",
			token: s.githubToken,
		});
	}
	if (!s.giteeOwner || !s.giteeRepo || !s.giteeToken) {
		throw new Error(messages().missingGiteeSettings);
	}
	return new GiteeBackend({
		owner: s.giteeOwner,
		repo: s.giteeRepo,
		branch: s.giteeBranch || "master",
		token: s.giteeToken,
	});
}
