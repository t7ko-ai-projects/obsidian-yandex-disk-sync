/** Slowest link a transfer is still expected to survive, in bytes per second. */
const FLOOR_BYTES_PER_SECOND = 20 * 1024;
/** Hard ceiling for one transfer, however large the file. */
const MAX_TRANSFER_MS = 15 * 60_000;
/** Transfers smaller than this say little about throughput. */
const MIN_SAMPLE_BYTES = 256 * 1024;
/** Weight of the newest sample in the throughput estimate. */
const SAMPLE_WEIGHT = 0.5;

/**
 * Time allowed for one transfer: the base timeout plus what the file needs at
 * the floor throughput, never above the ceiling and never below the base.
 */
export function scaledTransferTimeoutMs(
	baseMs: number,
	sizeBytes: number | undefined,
): number {
	if (!sizeBytes || sizeBytes <= 0) {
		return baseMs;
	}
	const needed = baseMs + (sizeBytes / FLOOR_BYTES_PER_SECOND) * 1000;
	return Math.max(baseMs, Math.min(MAX_TRANSFER_MS, needed));
}

/**
 * Smoothed throughput of recently completed transfers. Used to skip a file
 * whose predicted duration exceeds the ceiling instead of waiting for a timeout.
 */
export class ThroughputTracker {
	private bytesPerSecond: number | null = null;

	/** Record a completed transfer; small ones are ignored. */
	record(bytes: number, durationMs: number): void {
		if (bytes < MIN_SAMPLE_BYTES || durationMs <= 0) {
			return;
		}
		const sample = (bytes / durationMs) * 1000;
		this.bytesPerSecond =
			this.bytesPerSecond === null
				? sample
				: this.bytesPerSecond * (1 - SAMPLE_WEIGHT) +
					sample * SAMPLE_WEIGHT;
	}

	/** Predicted transfer time, or null while there is no measurement. */
	predictMs(bytes: number): number | null {
		return this.bytesPerSecond === null
			? null
			: (bytes / this.bytesPerSecond) * 1000;
	}

	/** True when the measured link cannot move `bytes` within the ceiling. */
	isTooSlow(bytes: number): boolean {
		const predicted = this.predictMs(bytes);
		return predicted !== null && predicted > MAX_TRANSFER_MS;
	}
}
