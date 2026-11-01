/** Summary of vault changes between snapshots, with per-file diffs. */

import { App, Modal, Notice, Setting } from "obsidian";
import { t } from "../i18n";
import { diffLines, splitLines, toHunks } from "../snapshots/line-diff";
import {
	compareFileMaps,
	decodeText,
	type SnapshotChanges,
} from "../snapshots/snapshot-diff";
import type { SnapshotManager } from "../snapshots/snapshot-manager";
import type { SnapshotManifest } from "../snapshots/snapshot-store";
import { logger } from "../utils/logger";

const MAX_ROWS = 1000;
const CURRENT = "current";

type Kind = "added" | "modified" | "deleted";

function describe(snapshot: SnapshotManifest): string {
	const time = new Date(snapshot.createdAt);
	const hours = String(time.getHours()).padStart(2, "0");
	const minutes = String(time.getMinutes()).padStart(2, "0");
	return `${snapshot.date} ${hours}:${minutes}`;
}

/** Name of the restored copy: `note (snapshot 2026-10-31).md`. */
export function restoredCopyPath(path: string, date: string): string {
	const slash = path.lastIndexOf("/");
	const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
	const name = path.slice(slash + 1);
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const extension = dot > 0 ? name.slice(dot) : "";
	return `${dir}${stem} (snapshot ${date})${extension}`;
}

export class SnapshotChangesModal extends Modal {
	private base: SnapshotManifest;
	private target: SnapshotManifest | typeof CURRENT;
	private changes: SnapshotChanges | null = null;
	private generation = 0;

	constructor(
		app: App,
		private readonly manager: SnapshotManager,
		private readonly snapshots: SnapshotManifest[],
		base: SnapshotManifest,
		target: SnapshotManifest | typeof CURRENT = CURRENT,
	) {
		super(app);
		this.base = base;
		this.target = target;
		this.setTitle(t("snapshot.title"));
		this.modalEl.addClass("ydsync-snapshot-modal");
	}

	async onOpen(): Promise<void> {
		await this.showList();
	}

	onClose(): void {
		this.generation++;
		this.contentEl.empty();
	}

	private async loadChanges(): Promise<SnapshotChanges> {
		if (this.target === CURRENT) {
			return (await this.manager.compareWithCurrent(this.base)).changes;
		}
		return compareFileMaps(this.base.files, this.target.files);
	}

	private async showList(): Promise<void> {
		const generation = ++this.generation;
		const { contentEl } = this;
		contentEl.empty();
		this.renderPickers(contentEl);
		const body = contentEl.createDiv();
		body.setText("...");
		try {
			this.changes = await this.loadChanges();
		} catch (error) {
			logger.error("Snapshot comparison failed", { error });
			body.setText(
				t("snapshot.failed", {
					message:
						error instanceof Error ? error.message : String(error),
				}),
			);
			return;
		}
		if (generation !== this.generation) {
			return;
		}
		body.empty();
		const changes = this.changes;
		body.createEl("p", {
			text: t("snapshot.summary", {
				added: String(changes.added.length),
				modified: String(changes.modified.length),
				deleted: String(changes.deleted.length),
				moved: String(changes.moved.length),
			}),
		});
		if (
			changes.added.length +
				changes.modified.length +
				changes.deleted.length +
				changes.moved.length ===
			0
		) {
			body.createEl("p", { text: t("snapshot.no_changes") });
			return;
		}
		let budget = MAX_ROWS;
		const groups: [string, Kind, string[]][] = [
			[t("snapshot.group_modified"), "modified", changes.modified],
			[t("snapshot.group_added"), "added", changes.added],
			[t("snapshot.group_deleted"), "deleted", changes.deleted],
		];
		for (const [title, kind, paths] of groups) {
			if (paths.length === 0) {
				continue;
			}
			body.createEl("h4", { text: `${title} (${paths.length})` });
			const list = body.createEl("ul", { cls: "ydsync-snapshot-list" });
			for (const path of paths.slice(0, Math.max(budget, 0))) {
				const link = list.createEl("li").createEl("a", { text: path });
				link.addEventListener("click", () => {
					void this.showDiff(kind, path);
				});
			}
			budget -= paths.length;
		}
		if (changes.moved.length > 0) {
			body.createEl("h4", {
				text: `${t("snapshot.group_moved")} (${changes.moved.length})`,
			});
			const list = body.createEl("ul", { cls: "ydsync-snapshot-list" });
			for (const move of changes.moved.slice(0, Math.max(budget, 0))) {
				list.createEl("li", { text: `${move.from} -> ${move.to}` });
			}
		}
		if (budget < 0) {
			body.createEl("p", {
				text: t("snapshot.list_truncated", { count: String(MAX_ROWS) }),
			});
		}
	}

	private renderPickers(container: HTMLElement): void {
		const row = container.createDiv({ cls: "ydsync-snapshot-pickers" });
		row.createSpan({ text: t("snapshot.from") });
		const from = row.createEl("select");
		for (const snapshot of this.snapshots) {
			from.createEl("option", {
				text: describe(snapshot),
				value: snapshot.id,
			}).selected = snapshot.id === this.base.id;
		}
		row.createSpan({ text: t("snapshot.to") });
		const to = row.createEl("select");
		to.createEl("option", {
			text: t("snapshot.current"),
			value: CURRENT,
		}).selected = this.target === CURRENT;
		for (const snapshot of this.snapshots) {
			to.createEl("option", {
				text: describe(snapshot),
				value: snapshot.id,
			}).selected =
				this.target !== CURRENT && snapshot.id === this.target.id;
		}
		const apply = () => {
			const base = this.snapshots.find((s) => s.id === from.value);
			if (!base) {
				return;
			}
			this.base = base;
			this.target =
				to.value === CURRENT
					? CURRENT
					: (this.snapshots.find((s) => s.id === to.value) ??
						CURRENT);
			void this.showList();
		};
		from.addEventListener("change", apply);
		to.addEventListener("change", apply);
	}

	private async readTarget(path: string): Promise<ArrayBuffer | null> {
		if (this.target === CURRENT) {
			const adapter = this.app.vault.adapter;
			return (await adapter.exists(path))
				? await adapter.readBinary(path)
				: null;
		}
		return await this.manager.readFromSnapshot(this.target, path);
	}

	private async showDiff(kind: Kind, path: string): Promise<void> {
		const generation = ++this.generation;
		const { contentEl } = this;
		contentEl.empty();
		new Setting(contentEl)
			.setName(path)
			.addButton((button) =>
				button.setButtonText(t("snapshot.back")).onClick(() => {
					void this.showList();
				}),
			)
			.then((setting) => {
				if (kind !== "added") {
					setting.addButton((button) =>
						button
							.setButtonText(t("snapshot.restore_copy"))
							.onClick(() => {
								void this.restoreCopy(path);
							}),
					);
				}
			});
		const output = contentEl.createDiv({ cls: "ydsync-diff" });
		try {
			const before = await this.manager.readFromSnapshot(this.base, path);
			const after = await this.readTarget(path);
			if (generation !== this.generation) {
				return;
			}
			const textBefore = before ? decodeText(before) : "";
			const textAfter = after ? decodeText(after) : "";
			const ops =
				textBefore === null || textAfter === null
					? null
					: diffLines(splitLines(textBefore), splitLines(textAfter));
			if (textBefore === null || textAfter === null) {
				output.setText(
					t("snapshot.binary", {
						before: String(before?.byteLength ?? 0),
						after: String(after?.byteLength ?? 0),
					}),
				);
				return;
			}
			if (ops === null) {
				output.setText(t("snapshot.diff_too_large"));
				return;
			}
			for (const hunk of toHunks(ops)) {
				output.createDiv({
					cls: "ydsync-diff-hunk",
					text: `@@ -${hunk.oldStart} +${hunk.newStart} @@`,
				});
				for (const op of hunk.ops) {
					const mark =
						op.type === "add" ? "+" : op.type === "del" ? "-" : " ";
					output.createDiv({
						cls: `ydsync-diff-line ydsync-diff-${op.type}`,
						text: `${mark} ${op.line}`,
					});
				}
			}
		} catch (error) {
			logger.error("Snapshot diff failed", { error });
			output.setText(
				t("snapshot.failed", {
					message:
						error instanceof Error ? error.message : String(error),
				}),
			);
		}
	}

	/** Save the snapshot version next to the original; never overwrites. */
	private async restoreCopy(path: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		try {
			const content = await this.manager.readFromSnapshot(
				this.base,
				path,
			);
			if (!content) {
				return;
			}
			const target = restoredCopyPath(path, this.base.date);
			if (await adapter.exists(target)) {
				new Notice(t("snapshot.restore_exists", { path: target }));
				return;
			}
			const parts = target.split("/").slice(0, -1);
			let directory = "";
			for (const part of parts) {
				directory = directory ? `${directory}/${part}` : part;
				if (!(await adapter.exists(directory))) {
					await adapter.mkdir(directory);
				}
			}
			await adapter.writeBinary(target, content);
			logger.info("Snapshot file restored as copy", {
				snapshot: this.base.id,
				source: path,
				target,
				bytes: content.byteLength,
			});
			new Notice(t("snapshot.restored", { path: target }));
		} catch (error) {
			logger.error("Snapshot restore failed", { error });
			new Notice(
				t("snapshot.failed", {
					message:
						error instanceof Error ? error.message : String(error),
				}),
			);
		}
	}
}
