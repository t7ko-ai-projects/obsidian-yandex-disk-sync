/** Scheduling and presentation glue for daily vault snapshots (desktop). */

import { App, Notice, Platform } from "obsidian";
import { t } from "../i18n";
import { SnapshotChangesModal } from "../ui/snapshot-modal";
import { logger } from "../utils/logger";
import { SnapshotManager, type SnapshotResult } from "./snapshot-manager";
import { hasChanges } from "./snapshot-diff";

const STARTUP_DELAY_MS = 60 * 1000;
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

export class SnapshotService {
	private readonly manager: SnapshotManager;
	private stopped = false;

	constructor(
		private readonly app: App,
		pluginDirectory: string,
		private readonly isEnabled: () => boolean,
		private readonly registerInterval: (id: number) => void,
	) {
		this.manager = new SnapshotManager(app.vault.adapter, pluginDirectory);
	}

	/** Check shortly after startup, then periodically while Obsidian stays open. */
	start(): void {
		const win =
			this.app.workspace.containerEl.ownerDocument.defaultView ?? window;
		win.setTimeout(() => void this.dailyCheck(), STARTUP_DELAY_MS);
		this.registerInterval(
			win.setInterval(() => void this.dailyCheck(), CHECK_INTERVAL_MS),
		);
	}

	stop(): void {
		this.stopped = true;
	}

	/** Take today's snapshot if it is missing and report what changed. */
	private async dailyCheck(): Promise<void> {
		if (this.stopped || !this.isEnabled() || !Platform.isDesktop) {
			return;
		}
		try {
			const result = await this.manager.createDailyIfMissing();
			if (result) {
				await this.present(result);
			}
		} catch (error) {
			logger.error("Daily snapshot failed", { error });
		}
	}

	/** Manual snapshot from the command palette or settings. */
	async takeNow(): Promise<void> {
		try {
			await this.present(await this.manager.createNow());
		} catch (error) {
			logger.error("Snapshot failed", { error });
			new Notice(
				t("snapshot.failed", {
					message:
						error instanceof Error ? error.message : String(error),
				}),
			);
		}
	}

	/** Compare the vault with the newest snapshot. */
	async showChanges(): Promise<void> {
		const snapshots = (await this.manager.list()).reverse();
		const latest = snapshots[0];
		if (!latest) {
			new Notice(t("snapshot.none"));
			return;
		}
		new SnapshotChangesModal(
			this.app,
			this.manager,
			snapshots,
			latest,
		).open();
	}

	private async present(result: SnapshotResult): Promise<void> {
		if (!result.previous || !result.changes) {
			new Notice(t("snapshot.created_first"));
			return;
		}
		const snapshots = (await this.manager.list()).reverse();
		const previous = snapshots.find((s) => s.id === result.previous?.id);
		if (!previous) {
			return;
		}
		if (!hasChanges(result.changes)) {
			new Notice(t("snapshot.no_changes"));
			return;
		}
		new SnapshotChangesModal(
			this.app,
			this.manager,
			snapshots,
			previous,
			result.manifest,
		).open();
	}
}
