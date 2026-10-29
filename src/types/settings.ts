export type BackendType = "gitee" | "github" | "gitlab" | "gitea";
export type CommitMode = "per-file" | "batch";
export type MergeStrategy = "mtime" | "remote" | "local";

/**
 * Plugin settings. Pure type — no runtime values (see DEFAULT_SETTINGS in
 * settings/settings-tab.ts). The GitLab fields (gitlab*) are read/written by
 * the GitLab backend; gitlabUrl defaults to https://gitlab.com.
 */
export interface SyncSettings {
	backend: BackendType;
	/* Gitee */
	giteeOwner: string;
	giteeRepo: string;
	giteeBranch: string;
	giteeToken: string;
	giteeTokenProfile: string;
	/* GitHub */
	githubOwner: string;
	githubRepo: string;
	githubBranch: string;
	githubToken: string;
	githubTokenProfile: string;
	/* GitLab */
	gitlabOwner: string;
	gitlabRepo: string;
	gitlabBranch: string;
	gitlabToken: string;
	gitlabTokenProfile: string;
	gitlabUrl: string;
	/* Gitea */
	giteaOwner: string;
	giteaRepo: string;
	giteaBranch: string;
	giteaToken: string;
	giteaTokenProfile: string;
	giteaUrl: string;
	/* common */
	autoSyncMinutes: number;
	syncOnStart: boolean;
	/** @deprecated Migrated to the plugin-managed section of .gitignore. */
	excludeFolders?: string;
	debugLog: boolean;
	commitMode: CommitMode;
	mergeStrategy: MergeStrategy;
	showSyncRibbon: boolean;
	showPanelRibbon: boolean;
}
