/** List sync conflicts and resolve each one against its original note. */

import { App, Modal, Notice, Setting, TFile } from "obsidian";
import { t } from "../i18n";
import { combineWithMarkers } from "../conflicts/conflict-merge";
import type {
	ConflictCopy,
	ConflictTracker,
} from "../conflicts/conflict-tracker";
import { decodeText } from "../snapshots/snapshot-diff";
import { computeSha256 } from "../utils/hash-utils";
import { logger } from "../utils/logger";
import { renderTextDiff } from "./diff-view";

type Action = "keep" | "use-copy" | "combine" | "restore" | "delete-copy";

export class ConflictResolverModal extends Modal {
	private generation = 0;

	constructor(
		app: App,
		private readonly tracker: ConflictTracker,
	) {
		super(app);
		this.setTitle(t("conflict.title"));
		this.modalEl.addClass("ydsync-snapshot-modal");
	}

	async onOpen(): Promise<void> {
		await this.tracker.refresh();
		this.showList();
	}

	onClose(): void {
		this.generation++;
		this.contentEl.empty();
	}

	private showList(): void {
		++this.generation;
		const { contentEl } = this;
		contentEl.empty();
		const copies = this.tracker.conflictCopies();
		const notes = this.tracker.markedNotes();
		if (copies.length + notes.length === 0) {
			contentEl.createEl("p", { text: t("conflict.none") });
			return;
		}
		if (copies.length > 0) {
			contentEl.createEl("h4", {
				text: t("conflict.copies_heading", {
					count: String(copies.length),
				}),
			});
			const list = contentEl.createEl("ul", {
				cls: "ydsync-snapshot-list",
			});
			for (const entry of copies) {
				const link = list
					.createEl("li")
					.createEl("a", { text: entry.original });
				link.addEventListener("click", () => {
					void this.showDetail(entry);
				});
			}
		}
		if (notes.length > 0) {
			contentEl.createEl("h4", {
				text: t("conflict.markers_heading", {
					count: String(notes.length),
				}),
			});
			const list = contentEl.createEl("ul", {
				cls: "ydsync-snapshot-list",
			});
			for (const note of notes) {
				const link = list.createEl("li").createEl("a", {
					text: `${note.path} (${note.blocks.length})`,
				});
				link.addEventListener("click", () => {
					this.close();
					void this.tracker.open(note.path, note.blocks[0] ?? 1);
				});
			}
		}
	}

	private file(path: string): TFile | null {
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? file : null;
	}

	private async showDetail(entry: ConflictCopy): Promise<void> {
		const generation = ++this.generation;
		const { contentEl } = this;
		contentEl.empty();
		const copyFile = this.file(entry.copy);
		if (!copyFile) {
			this.showList();
			return;
		}
		const originalFile = this.file(entry.original);
		try {
			const copyBytes = await this.app.vault.readBinary(copyFile);
			const originalBytes = originalFile
				? await this.app.vault.readBinary(originalFile)
				: null;
			if (generation !== this.generation) {
				return;
			}
			const loaded = {
				copy: await computeSha256(copyBytes),
				original: originalBytes
					? await computeSha256(originalBytes)
					: null,
			};
			const textual =
				decodeText(copyBytes) !== null &&
				(originalBytes === null || decodeText(originalBytes) !== null);
			this.renderDetail(
				entry,
				loaded,
				textual,
				originalBytes !== null,
				copyBytes,
				originalBytes,
			);
		} catch (error) {
			this.fail(error);
		}
	}

	private renderDetail(
		entry: ConflictCopy,
		loaded: { copy: string; original: string | null },
		textual: boolean,
		hasOriginal: boolean,
		copyBytes: ArrayBuffer,
		originalBytes: ArrayBuffer | null,
	): void {
		const { contentEl } = this;
		const setting = new Setting(contentEl).setName(entry.original);
		setting.setDesc(entry.copy);
		setting.addButton((button) =>
			button.setButtonText(t("conflict.back")).onClick(() => {
				this.showList();
			}),
		);
		const actions = new Setting(contentEl);
		const add = (label: string, action: Action, warning = false) => {
			actions.addButton((button) => {
				button.setButtonText(label).onClick(() => {
					void this.apply(entry, loaded, action);
				});
				if (warning) {
					button.buttonEl.addClass("mod-warning");
				}
			});
		};
		if (hasOriginal) {
			add(t("conflict.keep_original"), "keep");
			add(t("conflict.use_copy"), "use-copy", true);
			if (textual) {
				add(t("conflict.combine"), "combine");
			}
			actions.addButton((button) =>
				button.setButtonText(t("conflict.open_both")).onClick(() => {
					void this.openBoth(entry);
				}),
			);
		} else {
			contentEl.createEl("p", { text: t("conflict.original_missing") });
			add(t("conflict.restore_as_original"), "restore");
			add(t("conflict.delete_copy"), "delete-copy", true);
		}
		if (hasOriginal && !textual) {
			contentEl.createEl("p", { text: t("conflict.binary_note") });
		}
		contentEl.createEl("p", { text: t("conflict.hint") });
		renderTextDiff(
			contentEl.createDiv({ cls: "ydsync-diff" }),
			originalBytes,
			copyBytes,
		);
	}

	private async openBoth(entry: ConflictCopy): Promise<void> {
		const original = this.file(entry.original);
		const copy = this.file(entry.copy);
		if (!original || !copy) {
			return;
		}
		this.close();
		await this.app.workspace.getLeaf(false).openFile(original);
		await this.app.workspace.getLeaf("split", "vertical").openFile(copy);
	}

	/** Re-read both files and refuse to act on anything that changed since it was shown. */
	private async apply(
		entry: ConflictCopy,
		loaded: { copy: string; original: string | null },
		action: Action,
	): Promise<void> {
		try {
			const copyFile = this.file(entry.copy);
			const originalFile = this.file(entry.original);
			if (!copyFile) {
				this.showList();
				return;
			}
			const copyBytes = await this.app.vault.readBinary(copyFile);
			const originalBytes = originalFile
				? await this.app.vault.readBinary(originalFile)
				: null;
			const unchanged =
				(await computeSha256(copyBytes)) === loaded.copy &&
				(originalBytes
					? (await computeSha256(originalBytes)) === loaded.original
					: loaded.original === null);
			if (!unchanged) {
				new Notice(t("conflict.changed"));
				await this.showDetail(entry);
				return;
			}
			const vault = this.app.vault;
			if (action === "restore") {
				await this.app.fileManager.renameFile(copyFile, entry.original);
			} else {
				if (action === "use-copy" && originalFile) {
					await vault.modifyBinary(originalFile, copyBytes);
				} else if (
					action === "combine" &&
					originalFile &&
					originalBytes
				) {
					const merged = combineWithMarkers(
						decodeText(originalBytes) ?? "",
						decodeText(copyBytes) ?? "",
						{
							original: t("conflict.label_original"),
							copy: t("conflict.label_copy"),
						},
					);
					await vault.modify(originalFile, merged);
				}
				await this.app.fileManager.trashFile(copyFile);
			}
			logger.info("Sync conflict resolved", {
				action,
				original: entry.original,
			});
			new Notice(t("conflict.done", { path: entry.original }));
			await this.tracker.refresh();
			if (action === "combine") {
				this.close();
				const marked = this.tracker
					.markedNotes()
					.find((note) => note.path === entry.original);
				await this.tracker.open(entry.original, marked?.blocks[0] ?? 1);
				return;
			}
			this.showList();
		} catch (error) {
			this.fail(error);
		}
	}

	private fail(error: unknown): void {
		logger.error("Conflict resolution failed", { error });
		new Notice(
			t("conflict.failed", {
				message: error instanceof Error ? error.message : String(error),
			}),
		);
	}
}
