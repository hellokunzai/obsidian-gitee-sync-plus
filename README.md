# Gitee Sync Plus

[中文文档](./README.zh.md)

Sync your Obsidian vault to a private **Gitee or GitHub repository**. Gitee Sync Plus connects directly to the platform API — no server and no local Git installation required — and works on desktop, iOS, and Android.

## Features

- **Two-way incremental sync** between your vault and a private Git repository.
- **Three-way merge** using Git blob hashes and a per-device baseline (local / remote / last successful sync), so deletions and conflicts are resolved correctly across devices.
- **Conflict resolution** — when the same file changes on both sides, resolve each conflict by keeping local, using remote, or merging blocks; supports "apply to all".
- **Git panel** — a right-side source-control style view showing staged / unstaged / remote changes, with commit, pull, discard, stage/unstage, and per-file diff.
- **Diff viewer** — compare local and remote versions side by side or unified, revert individual change blocks, or mark a file as synced.
- **Automatic sync** on a timer, on startup, or on demand (ribbon, status bar, command palette, Git panel).
- **Dry-run preview** that writes the planned actions to a diagnostic note without touching either side.
- **Secure token storage** in the Obsidian keychain (no plaintext in `data.json`), with multiple named tokens per backend.
- **Per-file or batch commits**, and a configurable merge strategy (`mtime` / `remote` / `local`).
- **Exclusion rules** via a `.gitignore` file at the vault root.
- **Bilingual UI** that follows Obsidian's language (English / 中文).

## How it works

The sync engine computes a Git blob content hash for every file and performs a **three-way comparison** between the local vault, the remote repository, and the **per-device baseline** (the last successfully synced state, stored locally in the plugin's localStorage — never in `data.json`, so it stays device-specific).

- Local-only changes are uploaded; remote-only changes are downloaded.
- Deletions propagate in both directions.
- When the same file is modified on both sides, the **newer modification wins** (or the configured merge strategy decides).
- Every uploaded or deleted file creates a repository commit, so previous versions remain recoverable through Git history.
- If the remote platform returns a truncated file tree, sync stops to prevent accidental mass deletion.

The plugin interface automatically follows Obsidian's language and currently supports English and Chinese.

## Installation

In Obsidian, open **Settings → Community plugins → Browse**, search for **Gitee Sync Plus**, install it, and enable it.

For local development builds:

```bash
npm install
npm run build

mkdir -p "<vault>/.obsidian/plugins/gitee-sync-plus"
cp main.js manifest.json "<vault>/.obsidian/plugins/gitee-sync-plus/"
```

## Repository and token

**Gitee:** Create a private repository. In **Settings → Security Settings → Personal access tokens**, create a token with the **projects** permission.

**GitHub:** Create a private repository. A fine-grained personal access token needs **Contents: Read and write** access to the repository; a classic token needs the `repo` scope.

Tokens are stored in the Obsidian Secret Storage (Settings → Secrets) when available, and are no longer written to `data.json`. You can manage multiple named tokens per backend and switch between them from the settings panel.

## Configuration

| Setting | Description |
|---|---|
| Storage backend | Gitee repository or GitHub repository |
| Owner | User or organization from the repository URL |
| Repository | Private repository used for the vault |
| Branch | Gitee defaults to `master`; GitHub defaults to `main`. The dropdown auto-populates from the API once owner/repo/token are filled. |
| Token | Managed personal access tokens, stored in the Obsidian keychain. Click **Select token** to add or choose a saved token (with search and delete); click **Test** to verify it. |
| Automatic sync interval | Minutes between syncs; `0` disables automatic sync |
| Sync on startup | Runs one sync when Obsidian opens |
| Commit mode | **One commit per file** (default) or **one commit for all changes (batch)** |
| Merge strategy | How to resolve same-file conflicts during automatic/startup/scheduled sync: **Latest change time** (newer wins), **All remote**, or **All local** |
| Sync button | When enabled, shows a sync button in the left sidebar ribbon |
| Git panel button | When enabled, shows a Git panel button in the left sidebar ribbon |
| Diagnostic log | Writes the sync plan and result to `_gitee-sync-plus-log.md` |
| Excluded folders | Raw `.gitignore` rules at the vault root; edits take effect on the next sync |

Trigger sync from the ribbon icon, the **Sync now** command, the status bar, the timer, startup sync, or the Git panel. Use **Preview sync plan** to inspect planned actions without changing either side.

## Git panel

The Git panel is a right-sidebar view that mirrors a typical source-control sidebar, but runs on the plugin's three-way sync model (no local Git binary required). Open it with the **Open Git panel** command or the optional ribbon button.

- **Staged / Changes / Remote** groups list every file the next sync will touch.
- **Commit** pushes the staged local changes (with an optional commit message; in batch mode the message applies to the whole commit).
- **Pull** downloads remote changes; if conflicts exist, a conflict-resolution modal appears first.
- **Discard** reverts a local change to the last-synced remote version (or deletes a purely-local new file).
- **View diff** opens the diff viewer for any changed file.
- The panel auto-refreshes (debounced) when the vault changes and shows the current `owner/repo@branch` target.

## Conflict resolution

When a file is modified on **both** sides since the last sync, a conflict is detected.

- During a **Pull** from the Git panel, a modal lists every conflict. For each file you can **Keep local**, **Use remote**, or open the **Merge** editor to pick blocks (keep local / keep remote / keep both) and save the merged result. **Use remote for all** / **Keep local for all** resolve everything at once, then **Confirm pull** applies the choices.
- During **automatic / startup / scheduled** sync (no interactive prompt), the configured **Merge strategy** decides: `mtime` keeps the newer version, `remote` always takes the remote copy, `local` always keeps the local copy.

The diff viewer also lets you compare versions, revert individual change blocks, or mark a file as already-synced.

## Commands

| Command ID | Name | Description |
|---|---|---|
| `sync-now` | Sync now | Run a full two-way sync |
| `sync-preview` | Preview sync plan | Compute the plan and write it to the diagnostic note without changes |
| `open-git-panel` | Open Git panel | Open the right-sidebar Git panel |

## Multiple devices

Install and configure the plugin on every device with the same repository. Each device keeps its own sync baseline. A new device downloads the remote vault on its first sync and uses incremental sync afterwards.

Mobile operating systems suspend timers in the background, so enabling **Sync on startup** is recommended.

## iOS file visibility

If a downloaded folder is visible but a file with a non-standard extension is not, open **Settings → Files and links** and enable **Detect all file extensions**. The file may already be present but hidden by Obsidian's file explorer.

## Sync behavior

- Local-only changes are uploaded; remote-only changes are downloaded.
- Deletions propagate in both directions. Local deletions use Obsidian's trash, and remote history remains recoverable through Git.
- If both sides modify the same file, the newer modification wins. A modification wins over a deletion.
- Hidden paths such as `.obsidian` and `.git` are ignored on both sides.
- Sync stops if the remote platform returns a truncated file tree, preventing accidental mass deletion.
- Every uploaded or deleted file creates a repository commit, so previous versions remain recoverable.

## Limitations and security

- The first sync of a large vault creates one commit per file (per-file mode) and may be limited by platform API quotas.
- Keep large attachments in an excluded folder. Individual files should preferably remain below 50 MB.
- Tokens are stored in the Obsidian Secret Storage (Settings → Secrets), no longer in `data.json`. No need to exclude anything when backing up the vault with other tools. On mobile / older Obsidian versions without secret storage, the token falls back to `data.json`.
- Do not manually push the same vault to the same repository while the plugin manages it.

## Credits

This project is based on the original Gitee Sync plugin by **ericquan8**. The original work is retained under the MIT license (see `LICENSE`). Thanks to ericquan8 for the foundational implementation that this plugin builds upon.
