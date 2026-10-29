import { App, Modal, Notice, setIcon } from "obsidian";
import { messages } from "../utils/i18n";
import type CloudSyncPlugin from "../main";
import type { TokenHost } from "../utils/token-manager";

export class TokenSelectModal extends Modal {
	private selectedName: string | null;
	private searchQuery = "";
	private showAddForm = false;
	private visibleTokens = new Set<string>();
	private secrets: string[] = [];
	private listContainer!: HTMLElement;
	private addForm!: HTMLElement;
	private nameInput!: HTMLInputElement;
	private valueInput!: HTMLInputElement;

	constructor(
		app: App,
		private plugin: CloudSyncPlugin,
		private host: TokenHost,
		private onSave: () => void
	) {
		super(app);
		this.selectedName = this.plugin.tokenManager.getActiveKey(host);
	}

	onOpen(): void {
		this.modalEl.addClass("gitee-sync-plus-token-modal");

		const { contentEl } = this;
		contentEl.empty();
		const l = messages();

		contentEl.createEl("h2", { text: l.tokenSelectTitle, cls: "gitee-sync-plus-token-title" });

		// Search box
		const searchContainer = contentEl.createDiv({ cls: "gitee-sync-plus-token-search" });
		const searchInput = searchContainer.createEl("input", {
			type: "search",
			placeholder: l.tokenSearchPlaceholder,
			cls: "gitee-sync-plus-token-search-input",
		});
		searchInput.value = this.searchQuery;
		searchInput.addEventListener("input", () => {
			this.searchQuery = searchInput.value.trim().toLowerCase();
			this.renderList();
		});

		// Add form (hidden by default)
		this.addForm = contentEl.createDiv({ cls: "gitee-sync-plus-token-add-form" });
		this.addForm.style.display = this.showAddForm ? "block" : "none";

		this.nameInput = this.addForm.createEl("input", {
			type: "text",
			placeholder: l.tokenKeyId,
			cls: "gitee-sync-plus-token-add-input",
		});
		this.valueInput = this.addForm.createEl("input", {
			type: "password",
			placeholder: l.tokenValue,
			cls: "gitee-sync-plus-token-add-input",
		});

		const addFormButtons = this.addForm.createDiv({ cls: "gitee-sync-plus-token-add-buttons" });
		const confirmAddBtn = addFormButtons.createEl("button", { text: l.tokenConfirmAdd, cls: "mod-cta" });
		const cancelAddBtn = addFormButtons.createEl("button", { text: l.tokenCancel });

		confirmAddBtn.addEventListener("click", () => {
			void this.addSecret();
		});
		cancelAddBtn.addEventListener("click", () => {
			this.toggleAddForm(false);
		});

		// List container
		this.listContainer = contentEl.createDiv({ cls: "gitee-sync-plus-token-list" });

		// Footer buttons
		const footer = contentEl.createDiv({ cls: "gitee-sync-plus-token-footer" });
		const addBtn = footer.createEl("button", { text: l.tokenAdd });
		addBtn.addEventListener("click", () => {
			this.toggleAddForm(true);
			this.nameInput.focus();
		});

		const rightButtons = footer.createDiv({ cls: "gitee-sync-plus-token-footer-right" });
		const saveBtn = rightButtons.createEl("button", { text: l.tokenSave, cls: "mod-cta" });
		const cancelBtn = rightButtons.createEl("button", { text: l.tokenCancel });

		saveBtn.addEventListener("click", () => {
			void this.save();
		});
		cancelBtn.addEventListener("click", () => {
			this.close();
		});

		this.scope.register([], "Escape", () => this.close());

		// Load the actual keychain entries and then render.
		this.renderList();
		void this.loadSecrets();
	}

	private async loadSecrets(): Promise<void> {
		this.secrets = await this.plugin.tokenManager.listSecrets();
		this.renderList();
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}

	private toggleAddForm(show: boolean): void {
		this.showAddForm = show;
		this.addForm.style.display = show ? "block" : "none";
		if (!show) {
			this.nameInput.value = "";
			this.valueInput.value = "";
		}
	}

	private renderList(): void {
		const l = messages();
		this.listContainer.empty();
		const keys = this.secrets.filter((k) => k.toLowerCase().includes(this.searchQuery));

		if (keys.length === 0) {
			this.listContainer.createDiv({
				text: this.searchQuery ? l.tokenNoMatch : l.tokenEmpty,
				cls: "gitee-sync-plus-token-empty",
			});
			return;
		}

		for (const key of keys) {
			const isSelected = this.selectedName === key;
			const item = this.listContainer.createDiv({ cls: "gitee-sync-plus-token-item" });
			if (isSelected) item.addClass("is-selected");

			const left = item.createDiv({ cls: "gitee-sync-plus-token-item-left" });
			const radio = left.createEl("input", { type: "radio", value: key });
			radio.name = "token-select";
			radio.checked = isSelected;
			radio.addEventListener("change", () => {
				this.selectedName = key;
				this.renderList();
			});

			left.createSpan({ text: key, cls: "gitee-sync-plus-token-name" });

			if (isSelected) {
				left.createSpan({ text: l.tokenSelected, cls: "gitee-sync-plus-token-badge" });
			}

			const actions = item.createDiv({ cls: "gitee-sync-plus-token-actions" });

			// Eye toggle
			const isVisible = this.visibleTokens.has(key);
			const eyeBtn = actions.createEl("button", { cls: "gitee-sync-plus-token-icon-btn" });
			setIcon(eyeBtn, isVisible ? "eye-off" : "eye");
			eyeBtn.addEventListener("click", () => {
				if (isVisible) {
					this.visibleTokens.delete(key);
				} else {
					this.visibleTokens.add(key);
				}
				this.renderList();
			});

			// Delete button
			const delBtn = actions.createEl("button", { cls: "gitee-sync-plus-token-icon-btn" });
			setIcon(delBtn, "trash-2");
			delBtn.addEventListener("click", () => {
				if (confirm(l.tokenDeleteConfirm(key))) {
					void this.deleteSecret(key);
				}
			});

			// Show token value inline when visible
			if (isVisible) {
				void this.plugin.tokenManager.getToken(key).then((v) => {
					const valueEl = item.createDiv({ cls: "gitee-sync-plus-token-value" });
					valueEl.setText(v ?? "");
				});
			}
		}
	}

	private async addSecret(): Promise<void> {
		const l = messages();
		const rawName = this.nameInput.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
		const value = this.valueInput.value.trim();
		if (!rawName) {
			new Notice(l.tokenNameRequired);
			return;
		}
		if (!value) {
			new Notice(l.tokenValueRequired);
			return;
		}
		if (this.secrets.includes(rawName)) {
			new Notice(l.tokenDuplicateName);
			return;
		}
		try {
			await this.plugin.tokenManager.setToken(rawName, value);
			this.secrets.push(rawName);
			this.selectedName = rawName;
			this.toggleAddForm(false);
			this.renderList();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(l.tokenSaveFailed(msg), 8000);
		}
	}

	private async deleteSecret(name: string): Promise<void> {
		await this.plugin.tokenManager.deleteToken(name);
		this.secrets = this.secrets.filter((k) => k !== name);
		if (this.selectedName === name) {
			this.selectedName = null;
		}
		this.renderList();
	}

	private async save(): Promise<void> {
		await this.plugin.tokenManager.setActiveKey(this.host, this.selectedName);
		this.onSave();
		this.close();
	}
}
