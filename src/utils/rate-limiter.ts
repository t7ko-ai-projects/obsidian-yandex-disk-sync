import { RemoteReadInterruptedError } from "../errors";

/**
 * Spaces API calls evenly so bursts of parallel work stay below the provider's
 * request limit. Waiters keep their order and leave the queue when aborted.
 */
export class RequestRateLimiter {
	private nextSlotAt = 0;
	private intervalMs = 0;

	constructor(requestsPerSecond: number) {
		this.setRate(requestsPerSecond);
	}

	/** A rate of zero (or anything not a positive number) disables limiting. */
	setRate(requestsPerSecond: number): void {
		this.intervalMs =
			Number.isFinite(requestsPerSecond) && requestsPerSecond > 0
				? 1000 / requestsPerSecond
				: 0;
	}

	/** Wait for the next free slot; rejects when the signal aborts first. */
	async acquire(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) {
			throw new RemoteReadInterruptedError();
		}
		if (this.intervalMs === 0) {
			return;
		}
		const now = Date.now();
		const slotAt = Math.max(now, this.nextSlotAt);
		this.nextSlotAt = slotAt + this.intervalMs;
		const waitMs = slotAt - now;
		if (waitMs <= 0) {
			return;
		}
		await new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				clearTimeout(timer);
				reject(new RemoteReadInterruptedError());
			};
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, waitMs);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
}
