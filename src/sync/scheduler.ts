/**
 * Periodic synchronization scheduler
 */

import type { SyncEngine } from "./engine";
import type { YandexDiskSyncSettings } from "../types";
import { logger } from "../utils/logger";

export class SyncScheduler {
	private syncEngine: SyncEngine;
	private settings: YandexDiskSyncSettings;

	private intervalId: ReturnType<typeof setInterval> | null = null;
	private pollId: ReturnType<typeof setInterval> | null = null;
	private isRunning = false;
	private polling = false;
	private generation = 0;
	private canStartAutomatic: () => boolean = () => true;
	private deferred: () => void = () => {};
	private probe: (() => Promise<string | null>) | null = null;
	private baseline: { fingerprint: string; syncedAt?: number } | null = null;

	constructor(syncEngine: SyncEngine, settings: YandexDiskSyncSettings) {
		this.syncEngine = syncEngine;
		this.settings = settings;
	}

	/** Gate scheduled entry without changing the user's interval or an admitted session. */
	setAutomaticAdmission(
		canStart: () => boolean,
		deferred: () => void = () => {},
	): void {
		this.canStartAutomatic = canStart;
		this.deferred = deferred;
	}

	/**
	 * Provide a cheap remote-change probe: it returns the canonical index's
	 * content fingerprint, or null when it cannot be observed right now.
	 */
	setRemoteProbe(probe: () => Promise<string | null>): void {
		this.probe = probe;
	}

	/**
	 * Update settings
	 */
	updateSettings(settings: YandexDiskSyncSettings): void {
		const restart =
			this.isRunning &&
			(this.settings.syncInterval !== settings.syncInterval ||
				this.settings.remotePollSeconds !== settings.remotePollSeconds);
		this.settings = settings;
		if (restart) {
			this.stop();
			this.start();
		}
	}

	/**
	 * Start scheduler
	 */
	start(): void {
		if (this.isRunning || this.settings.manualSyncRequired) {
			return;
		}

		const intervalMinutes = this.settings.syncInterval;

		if (intervalMinutes <= 0) {
			logger.debug("Periodic synchronization disabled (interval = 0)");
			return;
		}

		const intervalMs = intervalMinutes * 60 * 1000;

		const generation = ++this.generation;
		this.intervalId = setInterval(() => {
			if (this.isRunning && generation === this.generation) {
				void this.runScheduledSync();
			}
		}, intervalMs);

		const pollSeconds = this.settings.remotePollSeconds;
		if (this.probe && pollSeconds > 0) {
			this.pollId = setInterval(() => {
				if (this.isRunning && generation === this.generation) {
					void this.pollRemote();
				}
			}, pollSeconds * 1000);
		}

		this.isRunning = true;
		logger.info(
			`SyncScheduler started with ${intervalMinutes} minute interval`,
		);
	}

	/**
	 * Stop scheduler
	 */
	stop(): void {
		this.generation++;
		if (!this.isRunning) {
			return;
		}

		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
		if (this.pollId) {
			clearInterval(this.pollId);
			this.pollId = null;
		}
		this.baseline = null;

		this.isRunning = false;
		logger.info("SyncScheduler stopped");
	}

	/**
	 * Observe the canonical index with one metadata request and start an
	 * ordinary full sync when another device changed it. A sync of our own
	 * resets the baseline, so only changes made elsewhere trigger one. The poll
	 * only brings the next sync forward; it never decides what to apply.
	 */
	private async pollRemote(): Promise<void> {
		if (
			this.polling ||
			!this.probe ||
			!this.canStartAutomatic() ||
			this.settings.manualSyncRequired ||
			this.syncEngine.isSyncInProgress() ||
			this.syncEngine.isSyncPaused()
		) {
			return;
		}
		this.polling = true;
		try {
			const syncedAt = this.syncEngine.getState().lastSyncTime;
			let fingerprint: string | null;
			try {
				fingerprint = await this.probe();
			} catch (e) {
				logger.debug("Remote change probe failed", { error: e });
				return;
			}
			if (!fingerprint) {
				return;
			}
			if (
				this.syncEngine.isSyncInProgress() ||
				this.syncEngine.getState().lastSyncTime !== syncedAt
			) {
				this.baseline = null;
				return;
			}
			const baseline = this.baseline;
			if (!baseline || baseline.syncedAt !== syncedAt) {
				this.baseline = { fingerprint, syncedAt };
				return;
			}
			if (baseline.fingerprint !== fingerprint) {
				logger.info("Remote canonical index changed; syncing now");
				await this.runScheduledSync();
			}
		} finally {
			this.polling = false;
		}
	}

	/**
	 * Run scheduled synchronization
	 */
	private async runScheduledSync(): Promise<void> {
		if (!this.canStartAutomatic()) {
			this.deferred();
			return;
		}
		if (this.settings.manualSyncRequired) {
			return;
		}
		if (this.syncEngine.isSyncInProgress()) {
			logger.debug(
				"Skipping scheduled synchronization: already in progress",
			);
			return;
		}

		if (this.syncEngine.isSyncPaused()) {
			logger.debug("Skipping scheduled synchronization: paused");
			return;
		}

		logger.info("Starting scheduled synchronization...");

		try {
			const result = await this.syncEngine.fullSync({
				trigger: "automatic",
			});

			if (result.success) {
				logger.info("Scheduled synchronization completed successfully");
			} else {
				logger.warn(
					`Scheduled synchronization completed with errors: ${result.errors.length}`,
				);
			}
		} catch (e) {
			logger.error("Scheduled synchronization error:", { error: e });
		}
	}
}
