# Gitee Sync Plus

> An Obsidian plugin that syncs your notes to **Gitee / GitHub / GitLab / Gitea** — without needing Git installed on your machine.

[English](README.en.md) · [简体中文](README.md)

---

## ✨ Features

- **No local Git required**: the plugin talks to each platform's REST API directly, so there is no need for a local Git install or the `git` command line.
- **Three-way sync**: it compares the local vault, the remote manifest, and the state recorded at the last successful sync — so it can tell "changed here" from "changed there", and propagates deletions in **both** directions.
- **Multi-platform**: one configuration switches freely between Gitee, GitHub, GitLab and Gitea. After switching backends, the next sync performs a full reconciliation and keeps the newer revision.
- **Conflict resolution**: when the same file changed on both sides, the newer modification time wins by default; you can also resolve manually (keep local / use remote / merge).
- **Diff view**: visualize changes with side-by-side or vertical layout, collapse unchanged runs, revert a single block, accept local or remote, or mark a file as synced.
- **Git panel**: an IDE-style source-control sidebar — lists local/remote changes, stage/unstage, commit (push), pull, discard, and view diffs.
- **Secure token storage**: access tokens are stored in the Obsidian keychain (SecretStorage) when available, so no plaintext lives in `data.json`; multiple named keys (profiles) are supported and legacy plaintext tokens are migrated automatically.
- **Automation**: configurable auto-sync interval (minutes) and sync-on-startup, plus manual triggers.
- **Commit strategies**: per-file commits or a single batched commit; conflict merge strategy selectable between latest-modification-time / all-remote / all-local.
- **Unified ignore rules**: all filtering is covered by a `.gitignore` at the vault root, using standard gitignore syntax.
- **Bilingual UI**: built-in Simplified Chinese and English.

> Mobile compatible (`manifest` declares `isDesktopOnly: false`). Note: the keychain relies on Obsidian 1.11.4+'s SecretStorage; on older clients the token falls back to `data.json` (plaintext — keep the repo private and exclude the log).

---

## 📦 Installation

### Option 1: BRAT (recommended, easiest to keep updated)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.
2. Run the command `BRAT: Add a beta plugin`.
3. Enter the repository: `hellokunzai/obsidian-gitee-sync-plus`.
4. Enable **Gitee Sync Plus**.

### Option 2: Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [Releases](https://github.com/hellokunzai/obsidian-gitee-sync-plus/releases) page.
2. Place them in `<your vault>/.obsidian/plugins/gitee-sync-plus/` (create the folder if needed).
3. Enable **Gitee Sync Plus** under Settings → Community plugins.

---

## ⚙️ Quick setup

Open **Settings → Gitee Sync Plus**:

1. **Storage backend**: choose Gitee / GitHub / GitLab / Gitea.
2. **Access token**: click *Select token* to pick a key from the Obsidian keychain (or *Add key…* to create a named key and paste the token); use *Test* to verify it works.
   - Gitee: Settings → Security Settings → Personal access tokens; enable the `projects` scope.
   - GitHub: Settings → Developer settings → Personal access tokens; enable the `repo` scope.
   - GitLab: Settings → Access Tokens; needs `api` (or `read_repository` + `write_repository`).
   - Gitea: Settings → Applications → Generate Token (or your instance's token page); needs repo read/write.
3. **Owner** and **Repository name**: the user/organization that owns the repo (the `owner` in its URL) and the repo name. A dedicated **private repository** is recommended.
4. **Branch**: after filling in the above, click *Refresh branches* to auto-populate, or type it manually (Gitee defaults to `master`, others to `main`).
   - For GitLab / Gitea, also set the instance URL in the corresponding field (hosted defaults: `https://gitlab.com`, `https://gitea.com`).
5. (Optional) **Sync settings**: enable the *Sync button* (left ribbon), *Sync on startup*, and set the *auto-sync interval*.
6. (Optional) **Advanced**: enable the *Git panel button*, turn on *Diagnostic log*, and adjust *Merge strategy* / *Commit mode* as needed.

Once configured, click the status bar, the left ribbon sync icon, or run **Sync now** from the command palette.

---

## 💻 Commands & entry points

| Entry point | Description |
| --- | --- |
| Status bar | Shows sync status; click to trigger a sync |
| Left ribbon sync icon | Quick sync (can be disabled in settings) |
| Left ribbon Git panel icon | Open the right-side Git panel (off by default) |
| Command: `Sync now` | Sync immediately |
| Command: `Preview sync plan` | Preview the sync plan without executing (written to the diagnostic note) |
| Command: `Open Git panel` | Open the Git panel |
| Command: `Reset sync state (current repository)` | Clears the baseline for the **current** repository only; next sync treats it as a fresh target and pushes everything (other repositories' baselines are kept) |

---

## 🗂️ Git panel

Open the right-side **Git panel** via the ribbon icon or command. It works like an IDE's source-control sidebar:

- **Local changes**: files that will be pushed on the next sync. You can *stage*, *view diff*, or *discard* each one, or stage/discard all.
- **Remote changes**: files that will be pulled / deleted locally on the next sync.
- **Commit**: push staged local changes; in batch mode a commit message can be entered at the top.
- **Pull**: download remote changes (phase one of a sync).
- **Refresh**: recompute local/remote differences.
- Click any file to open the **diff view**.

---

## 🔀 Conflict resolution

When a file changed on **both** sides since the last sync, a conflict-resolution window appears on pull:

1. Review each conflict and choose:
   - **Keep local** — use the local version;
   - **Use remote** — use the remote version;
   - **Merge…** — open the merge editor, pick a side (or keep both) for each conflicting block; the result is editable.
2. Or use *Keep local for all* / *Use remote for all* in one click.
3. Confirm with **Confirm pull** to finish.

> Non-interactive syncs (button, startup, scheduled) resolve automatically per the *Merge strategy* setting.

The diff view also supports: side-by-side / vertical layout toggle, collapsing unchanged runs, reverting / accepting local or remote per block, and *Mark as synced* (removes the file from pending changes, treating it as already consistent).

---

## 🚫 Exclusions (.gitignore)

All filtering is driven by a **`.gitignore` at the vault root** (standard gitignore syntax). Edit the rules in Settings → Excluded folders; they are saved on blur and take effect on the next sync.

It is recommended to exclude at least the plugin's own state and log so they are not synced between devices:

```gitignore
# Plugin diagnostic log (sync plan & results; should not be synced)
_gitee-sync-plus-log.md

# Other content you don't want synced (examples)
# .obsidian/
# Templates/
```

---

## 🔒 Security & privacy

- **Tokens in the keychain**: when supported, access tokens are written to the Obsidian keychain (`secretStorage`); `data.json` keeps only the key name, not the plaintext value. Opening the settings page automatically migrates any legacy plaintext token into the keychain.
- **Log excluded by default**: the diagnostic log `_gitee-sync-plus-log.md` contains sync details and is excluded via the `.gitignore` example above.
- **Private repository**: a dedicated **private repository** for your notes is strongly recommended.
- **Multiple keys**: maintain several named keys in the keychain (e.g. personal vs. work tokens) and choose which one each backend uses.

---

## 🛠️ Troubleshooting

| Symptom | Where to look |
| --- | --- |
| GitLab *Test* succeeds but sync fails | If the repo is not empty, the token likely lacks `read_repository`/`api` read scope (`GET /projects/:id` only needs `read_api`, so the connection test passes while the sync cannot read content). Grant `api` (or `read_repository` + `write_repository`). |
| GitLab reports a protected branch / cannot write | The target branch is protected and the token's role cannot push. Re-create the token with the Maintainer role, or in project Settings → Repository → Protected branches allow Developers to push. |
| Remote file tree was truncated | The remote returned a truncated tree (too many files); sync was stopped to prevent accidental deletion. Narrow the sync scope with `.gitignore`. |
| A file differing only by line endings keeps changing | The engine compares LF-normalized hashes, so CRLF-vs-LF differences are ignored; if it still triggers, it's a real content change. |
| No debug log produced | Make sure *Diagnostic log* is enabled under Advanced and that the log file isn't excluded from being written by `.gitignore`. |

---

## 🔗 Relationship to Gitee Sync

This plugin is a fork of the community **Gitee Sync** plugin with a rewritten sync engine: all filter conditions are unified under the `.gitignore` mechanism, and it supports both Gitee and GitHub (and now GitLab and Gitea) without requiring a local Git install.

---

## 📄 License

[MIT](LICENSE)
