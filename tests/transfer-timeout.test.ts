import assert from "node:assert/strict";
import test from "node:test";
import {
	scaledTransferTimeoutMs,
	ThroughputTracker,
} from "../src/utils/transfer-timeout";

test("transfer timeout grows with file size within a ceiling and a slow measured link defers a file", () => {
	const base = 60_000;
	assert.equal(scaledTransferTimeoutMs(base, undefined), base);
	assert.equal(scaledTransferTimeoutMs(base, 10 * 1024), base + 500);
	// The photo that timed out at 60 s on a slow phone now gets minutes.
	assert.ok(scaledTransferTimeoutMs(base, 3 * 1024 * 1024) > 180_000);
	assert.equal(scaledTransferTimeoutMs(base, 10 * 1024 ** 3), 15 * 60_000);

	const link = new ThroughputTracker();
	assert.equal(link.isTooSlow(500 * 1024 ** 2), false, "no measurement yet");
	link.record(100 * 1024, 1000);
	assert.equal(link.predictMs(1024), null, "tiny samples are ignored");
	link.record(1024 * 1024, 30_000);
	assert.equal(link.isTooSlow(1024 * 1024), false);
	assert.equal(link.isTooSlow(50 * 1024 * 1024), true);
	for (let i = 0; i < 6; i++) {
		link.record(10 * 1024 * 1024, 2000);
	}
	assert.equal(
		link.isTooSlow(50 * 1024 * 1024),
		false,
		"recovers on a fast link",
	);
});
