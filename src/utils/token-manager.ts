import type CloudSyncPlugin from "../main";

/** Key names used by this plugin before named profiles were introduced. */
export const LEGACY_SECRET_GITEE = "gitee-sync-plus-gitee";
export const LEGACY_SECRET_GITHUB = "gitee-sync-plus-github";

export type TokenHost = "gitee" | "github" | "gitlab" | "gitea";

/**
 * Reads the list of secret IDs stored in Obsidian's keychain.
 *
 * Obsidian 1.11.4+ exposes `app.secretStorage.listSecrets(): string[]`. The
 * call may be synchronous or return a Promise depending on the exact runtime,
 * so we wrap it with `Promise.resolve` for safety.
 */
async function listSecretIds(ss: NonNullable<CloudSyncPlugin["app"]["secretStorage"]>): Promise<string[]> {
	try {
		const result = ss.listSecrets();
		return (await Promise.resolve(result)) ?? [];
	} catch {
		return [];
	}
}

/**
 * Wraps `getSecret` so it works whether the runtime returns the value
 * synchronously or as a Promise.
 */
async function getSecret(ss: NonNullable<CloudSyncPlugin["app"]["secretStorage"]>, id: string): Promise<string | null> {
	try {
		const value = ss.getSecret(id);
		return (await Promise.resolve(value)) ?? null;
	} catch {
		return null;
	}
}

/**
 * Wraps `setSecret` so it works whether the runtime is synchronous or async.
 */
async function setSecret(ss: NonNullable<CloudSyncPlugin["app"]["secretStorage"]>, id: string, secret: string): Promise<void> {
	await Promise.resolve(ss.setSecret(id, secret));
}

/**
 * Manages access to Obsidian's SecretStorage.
 *
 * This plugin no longer maintains its own profile registry. Instead, the
 * "Select token" dialog simply lists every key returned by
 * `app.secretStorage.listSecrets()` and lets the user pick one (or create a
 * new one). The selected key name is stored in settings; the value is read from
 * the keychain on demand.
 */
export class TokenManager {
	constructor(private plugin: CloudSyncPlugin) {}

	private get ss() {
		return this.plugin.app.secretStorage;
	}

	/** List every secret ID currently stored in Obsidian's keychain. */
	async listSecrets(): Promise<string[]> {
		const ss = this.ss;
		if (!ss) return [];
		return listSecretIds(ss);
	}

	/** Read the secret value for a given key. */
	async getToken(key: string): Promise<string | null> {
		const ss = this.ss;
		if (!ss) return null;
		return getSecret(ss, key);
	}

	/** Write or overwrite a secret value under the given key. */
	async setToken(key: string, value: string): Promise<void> {
		const ss = this.ss;
		if (!ss) throw new Error("secretStorage unavailable");
		await setSecret(ss, key, value);
	}

	/**
	 * Clear a secret. Obsidian's SecretStorage does not expose deleteSecret,
	 * so we overwrite the value with an empty string.
	 */
	async deleteToken(key: string): Promise<void> {
		const ss = this.ss;
		if (!ss) return;
		try {
			await setSecret(ss, key, "");
		} catch {
			/* ignore */
		}
	}

	/** Get the currently selected secret key for a host. */
	getActiveKey(host: TokenHost): string {
		const s = this.plugin.settings;
		if (host === "gitee") return s.giteeTokenProfile;
		if (host === "github") return s.githubTokenProfile;
		if (host === "gitea") return s.giteaTokenProfile;
		return s.gitlabTokenProfile;
	}

	/** Set which secret key is active for a host. */
	async setActiveKey(host: TokenHost, key: string | null): Promise<void> {
		const s = this.plugin.settings;
		if (host === "gitee") {
			s.giteeTokenProfile = key ?? "";
		} else if (host === "github") {
			s.githubTokenProfile = key ?? "";
		} else if (host === "gitea") {
			s.giteaTokenProfile = key ?? "";
		} else {
			s.gitlabTokenProfile = key ?? "";
		}
		await this.refreshInMemoryToken(host);
		await this.plugin.savePluginData();
	}

	/** Refresh the in-memory token from the active key. */
	async refreshInMemoryToken(host: TokenHost): Promise<void> {
		const key = this.getActiveKey(host);
		const token = key ? await this.getToken(key) : null;
		const s = this.plugin.settings;
		if (host === "gitee") {
			s.giteeToken = token ?? "";
		} else if (host === "github") {
			s.githubToken = token ?? "";
		} else if (host === "gitea") {
			s.giteaToken = token ?? "";
		} else {
			s.gitlabToken = token ?? "";
		}
	}

	/**
	 * One-shot migration from the legacy single-token settings to the new
	 * keychain-first model. If data.json still contains a plaintext token and
	 * no active key is selected, the token is written under the legacy keychain
	 * key and that key becomes the active selection.
	 * @returns true if at least one token was migrated.
	 *
	 * GitLab never used a legacy secret (it shipped after this migration), so
	 * only Gitee and GitHub are handled here.
	 */
	async migrateLegacyTokens(): Promise<boolean> {
		const ss = this.ss;
		if (!ss) return false;

		const migrate = async (
			host: "gitee" | "github",
			settingKey: "giteeToken" | "githubToken",
			profileKey: "giteeTokenProfile" | "githubTokenProfile",
			legacyKey: string
		) => {
			const token = this.plugin.settings[settingKey];
			if (token && !this.plugin.settings[profileKey]) {
				await setSecret(ss, legacyKey, token);
				this.plugin.settings[profileKey] = legacyKey;
				dirty = true;
			}
		};

		let dirty = false;
		await migrate("gitee", "giteeToken", "giteeTokenProfile", LEGACY_SECRET_GITEE);
		await migrate("github", "githubToken", "githubTokenProfile", LEGACY_SECRET_GITHUB);

		if (dirty) {
			await this.plugin.savePluginData();
		}
		return dirty;
	}
}
