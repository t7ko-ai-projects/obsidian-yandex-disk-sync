import assert from "node:assert/strict";
import test from "node:test";
import { RemoteReadInterruptedError } from "../src/errors";
import { SyncScheduler } from "../src/sync/scheduler";
import { DEFAULT_SETTINGS } from "../src/types";
import { RequestRateLimiter } from "../src/utils/rate-limiter";

test("rate limiter spaces queued calls, honors abort and can be disabled", async () => {
	const limiter = new RequestRateLimiter(20);
	const startedAt = Date.now();
	const finished: number[] = [];
	await Promise.all(
		[0, 1, 2, 3].map(async () => {
			await limiter.acquire();
			finished.push(Date.now() - startedAt);
		}),
	);
	// Four calls at 20/s need at least three 50 ms gaps; allow timer slack.
	assert.ok(
		finished[3]! >= 120,
		`calls were not spaced: ${finished.join(",")}`,
	);

	const controller = new AbortController();
	const waiting = limiter.acquire(controller.signal);
	controller.abort();
	await assert.rejects(waiting, RemoteReadInterruptedError);

	limiter.setRate(0);
	const unlimitedAt = Date.now();
	await Promise.all([1, 2, 3, 4, 5].map(() => limiter.acquire()));
	assert.ok(Date.now() - unlimitedAt < 40);
});

test("remote poll syncs only for another device's change", async () => {
	let lastSyncTime = 1;
	let inProgress = false;
	let fullSyncs = 0;
	const engine = {
		isSyncInProgress: () => inProgress,
		isSyncPaused: () => false,
		getState: () => ({ lastSyncTime }),
		fullSync: async () => {
			fullSyncs++;
			lastSyncTime++;
			return { success: true, errors: [] };
		},
	};
	let fingerprint: string | null = "sha256:a";
	let probes = 0;
	let failProbe = false;
	const scheduler = new SyncScheduler(engine as never, {
		...DEFAULT_SETTINGS,
	});
	scheduler.setRemoteProbe(async () => {
		probes++;
		if (failProbe) {
			throw new Error("offline");
		}
		return fingerprint;
	});
	const poll = () =>
		(scheduler as unknown as { pollRemote(): Promise<void> }).pollRemote();

	await poll();
	assert.equal(fullSyncs, 0, "first observation only records a baseline");
	await poll();
	assert.equal(fullSyncs, 0, "unchanged index never syncs");

	failProbe = true;
	await poll();
	failProbe = false;
	fingerprint = null;
	await poll();
	assert.equal(fullSyncs, 0, "a failed or unreadable probe never syncs");

	fingerprint = "sha256:b";
	await poll();
	assert.equal(fullSyncs, 1, "another device's change syncs once");

	// Our own sync changed the index; the next poll adopts it silently.
	await poll();
	await poll();
	assert.equal(fullSyncs, 1);

	fingerprint = "sha256:c";
	lastSyncTime++;
	await poll();
	assert.equal(fullSyncs, 1, "a sync finishing since the baseline resets it");

	inProgress = true;
	const probesBefore = probes;
	fingerprint = "sha256:d";
	await poll();
	assert.equal(probes, probesBefore, "no probe while a sync is running");
	assert.equal(fullSyncs, 1);
});
