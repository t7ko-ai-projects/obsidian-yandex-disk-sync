import assert from "node:assert/strict";
import test from "node:test";
import { diffLines, toHunks, type DiffOp } from "../src/snapshots/line-diff";
import {
	DAILY_SNAPSHOT_COUNT,
	WEEKLY_SNAPSHOT_COUNT,
	isoWeekStart,
	localDateKey,
	selectSnapshotsToKeep,
	type SnapshotRef,
} from "../src/snapshots/retention";
import { compareFileMaps } from "../src/snapshots/snapshot-diff";
import { SnapshotManager } from "../src/snapshots/snapshot-manager";
import type { SnapshotAdapter } from "../src/snapshots/snapshot-store";

const refs = (dates: string[]): SnapshotRef[] =>
	dates.map((date) => ({
		id: date,
		date,
		createdAt: Date.parse(`${date}T12:00:00Z`),
	}));

const kept = (dates: string[]) =>
	[...selectSnapshotsToKeep(refs(dates))].sort().reverse();

test("retention keeps 7 daily plus 3 weekly snapshots whatever the gaps", () => {
	const consecutive = Array.from({ length: 40 }, (_, i) => {
		const day = new Date(Date.UTC(2026, 9, 31 - i));
		return day.toISOString().slice(0, 10);
	});
	const cases: [string, string[], string[]][] = [
		[
			"every day",
			consecutive,
			[
				...Array.from({ length: 7 }, (_, i) => `2026-10-${31 - i}`),
				"2026-10-24",
				"2026-10-18",
				"2026-10-11",
			],
		],
		[
			"sparse days still fill both tiers",
			[
				"2026-10-31",
				"2026-10-30",
				"2026-10-28",
				"2026-10-20",
				"2026-10-19",
				"2026-10-12",
				"2026-10-11",
				"2026-10-05",
				"2026-10-04",
				"2026-09-28",
				"2026-09-20",
				"2026-09-10",
			],
			[
				"2026-10-31",
				"2026-10-30",
				"2026-10-28",
				"2026-10-20",
				"2026-10-19",
				"2026-10-12",
				"2026-10-11",
				"2026-10-05",
				"2026-10-04",
				"2026-09-20",
			],
		],
		[
			"a long absence keeps the newest snapshots",
			Array.from(
				{ length: 10 },
				(_, i) => `2026-08-${String(i + 1).padStart(2, "0")}`,
			),
			[
				...Array.from(
					{ length: 7 },
					(_, i) => `2026-08-${String(10 - i).padStart(2, "0")}`,
				),
				"2026-08-03",
				"2026-08-02",
			],
		],
		[
			"fewer than seven snapshots are all kept",
			["2026-10-31", "2026-09-01"],
			["2026-10-31", "2026-09-01"],
		],
	];
	for (const [name, input, expected] of cases) {
		assert.deepEqual(kept(input), [...expected].sort().reverse(), name);
	}
	// Two snapshots on one date: only the newer one can be kept.
	const twice: SnapshotRef[] = [
		{ id: "early", date: "2026-10-31", createdAt: 1 },
		{ id: "late", date: "2026-10-31", createdAt: 2 },
	];
	assert.deepEqual([...selectSnapshotsToKeep(twice)], ["late"]);
});

test("retention is stable under random gaps over simulated years", () => {
	let seed = 12345;
	const random = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed / 4294967296;
	};
	let snapshots: SnapshotRef[] = [];
	for (let day = 0; day < 1200; day++) {
		// Obsidian is sometimes closed for days or months at a time.
		const closed = day % 300 > 250 ? 0.95 : 0.35;
		if (random() > closed) {
			const date = new Date(Date.UTC(2024, 0, 1 + day))
				.toISOString()
				.slice(0, 10);
			snapshots.push({ id: date, date, createdAt: day });
			const keep = selectSnapshotsToKeep(snapshots);
			const newest = snapshots[snapshots.length - 1]!;
			assert.ok(keep.has(newest.id), "the newest snapshot must be kept");
			snapshots = snapshots.filter((s) => keep.has(s.id));
			assert.ok(
				snapshots.length <=
					DAILY_SNAPSHOT_COUNT + WEEKLY_SNAPSHOT_COUNT,
			);
			assert.deepEqual(
				[...selectSnapshotsToKeep(snapshots)].sort(),
				snapshots.map((s) => s.id).sort(),
				"re-applying the policy must change nothing",
			);
		}
	}
	// Weekly representatives are the last snapshot of their week once it ends.
	const weeks = snapshots
		.slice(0, -DAILY_SNAPSHOT_COUNT)
		.map((s) => isoWeekStart(s.date));
	assert.equal(new Set(weeks).size, weeks.length, "one snapshot per week");
	assert.equal(localDateKey(new Date(2026, 0, 5)), "2026-01-05");
});

test("line diff reconstructs both texts for random edits", () => {
	let seed = 99;
	const random = (n: number) => {
		seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
		return seed % n;
	};
	for (let round = 0; round < 300; round++) {
		const before = Array.from(
			{ length: random(30) },
			() => `l${random(6)}`,
		);
		const after = Array.from({ length: random(30) }, () => `l${random(6)}`);
		const ops = diffLines(before, after);
		assert.ok(ops);
		const lines = (ops: DiffOp[], drop: DiffOp["type"]) =>
			ops.filter((op) => op.type !== drop).map((op) => op.line);
		assert.deepEqual(lines(ops, "add"), before);
		assert.deepEqual(lines(ops, "del"), after);
		const hunkChanges = toHunks(ops).flatMap((h) =>
			h.ops.filter((op) => op.type !== "eq"),
		);
		assert.equal(
			hunkChanges.length,
			ops.filter((op) => op.type !== "eq").length,
			"hunks must cover every change",
		);
	}
});

test("file map comparison pairs moves and ignores ambiguous empties", () => {
	const entry = (sha: string, size = 5) => ({ sha256: sha, size, mtime: 1 });
	const changes = compareFileMaps(
		{
			"kept.md": entry("a"),
			"old.md": entry("b"),
			"gone.md": entry("c"),
			"empty-old.md": entry("e", 0),
			"edited.md": entry("d"),
		},
		{
			"kept.md": entry("a"),
			"new/old.md": entry("b"),
			"edited.md": entry("x"),
			"empty-new.md": entry("e", 0),
		},
	);
	assert.deepEqual(changes, {
		added: ["empty-new.md"],
		modified: ["edited.md"],
		deleted: ["empty-old.md", "gone.md"],
		moved: [{ from: "old.md", to: "new/old.md" }],
	});
});

/** In-memory adapter that, like the real one, refuses writes into missing folders. */
class MemoryAdapter implements SnapshotAdapter {
	files = new Map<string, { data: ArrayBuffer; mtime: number }>();
	folders = new Set<string>([""]);
	clock = 0;
	failWrite?: (path: string) => boolean;
	failRead?: (path: string) => boolean;

	private parent(path: string) {
		return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
	}
	exists = async (path: string) =>
		this.files.has(path) || this.folders.has(path);
	mkdir = async (path: string) => {
		assert.ok(this.folders.has(this.parent(path)), `mkdir parent ${path}`);
		this.folders.add(path);
	};
	list = async (path: string) => ({
		files: [...this.files.keys()].filter((f) => this.parent(f) === path),
		folders: [...this.folders].filter(
			(f) => f !== "" && this.parent(f) === path,
		),
	});
	readBinary = async (path: string) => {
		assert.ok(this.files.has(path), `read missing ${path}`);
		if (this.failRead?.(path)) {
			throw new Error("synthetic read failure");
		}
		return this.files.get(path)!.data.slice(0);
	};
	writeBinary = async (path: string, data: ArrayBuffer) => {
		assert.ok(this.folders.has(this.parent(path)), `write parent ${path}`);
		if (this.failWrite?.(path)) {
			throw new Error("synthetic write failure");
		}
		this.files.set(path, { data: data.slice(0), mtime: this.clock });
	};
	rename = async (from: string, to: string) => {
		const file = this.files.get(from)!;
		this.files.delete(from);
		this.files.set(to, file);
	};
	remove = async (path: string) => {
		this.files.delete(path);
	};
	stat = async (path: string) => {
		const file = this.files.get(path);
		return file
			? {
					type: "file" as const,
					ctime: 0,
					mtime: file.mtime,
					size: file.data.byteLength,
				}
			: null;
	};
	put(path: string, text: string) {
		for (
			let at = path.indexOf("/");
			at >= 0;
			at = path.indexOf("/", at + 1)
		) {
			this.folders.add(path.slice(0, at));
		}
		this.files.set(path, {
			data: new TextEncoder().encode(text).buffer as ArrayBuffer,
			mtime: this.clock,
		});
	}
}

/** The configuration folder is user-configurable; any name must work. */
const CONFIG_DIR = ".config-folder";
const PLUGIN = `${CONFIG_DIR}/plugins/t7-yandex-disk-sync`;

function setup() {
	const adapter = new MemoryAdapter();
	adapter.folders.add(CONFIG_DIR);
	adapter.folders.add(`${CONFIG_DIR}/plugins`);
	adapter.folders.add(PLUGIN);
	let day = 0;
	adapter.clock = new Date(2026, 9, 1, 9).getTime();
	const manager = new SnapshotManager(
		adapter,
		PLUGIN,
		() => new Date(2026, 9, 1 + day, 9, 0, 0),
	);
	const advance = (days: number) => {
		day += days;
		adapter.clock = new Date(2026, 9, 1 + day, 9).getTime();
	};
	return { adapter, manager, advance };
}

const blobCount = (adapter: MemoryAdapter) =>
	[...adapter.files.keys()].filter((path) => path.includes("/blobs/")).length;

test("daily snapshots summarize changes, deduplicate content and skip plugin data", async () => {
	const { adapter, manager, advance } = setup();
	adapter.put("a.md", "alpha");
	adapter.put("copy-of-a.md", "alpha");
	adapter.put("photos/p.jpg", "pixels");
	adapter.put("rename-me.md", "keep this text");
	adapter.put(`${PLUGIN}/data.json`, '{"token":"never snapshotted"}');
	const first = await manager.createDailyIfMissing();
	assert.ok(first && first.previous === null);
	assert.deepEqual(Object.keys(first.manifest.files).sort(), [
		"a.md",
		"copy-of-a.md",
		"photos/p.jpg",
		"rename-me.md",
	]);
	assert.equal(blobCount(adapter), 3, "identical files share one blob");
	assert.equal(await manager.createDailyIfMissing(), null, "once per day");

	advance(1);
	adapter.put("a.md", "alpha edited");
	adapter.files.delete("photos/p.jpg");
	adapter.put("new.md", "brand new");
	adapter.files.delete("rename-me.md");
	adapter.put("moved/rename-me.md", "keep this text");
	const second = await manager.createDailyIfMissing();
	assert.ok(second?.changes);
	assert.deepEqual(second.changes, {
		added: ["new.md"],
		modified: ["a.md"],
		deleted: ["photos/p.jpg"],
		moved: [{ from: "rename-me.md", to: "moved/rename-me.md" }],
	});
	const old = await manager.readFromSnapshot(first.manifest, "a.md");
	assert.equal(new TextDecoder().decode(old!), "alpha");
	const live = await manager.compareWithCurrent(second.manifest);
	assert.deepEqual(live.changes.modified, []);
});

test("a gap of days still produces a summary against the last snapshot", async () => {
	const { adapter, manager, advance } = setup();
	adapter.put("n.md", "v1");
	await manager.createDailyIfMissing();
	advance(5);
	adapter.put("n.md", "v2 after a break");
	const result = await manager.createDailyIfMissing();
	assert.deepEqual(result?.changes?.modified, ["n.md"]);
	assert.equal(result?.previous?.date, "2026-10-01");
});

test("retention prunes old snapshots and reclaims only unreferenced content", async () => {
	const { adapter, manager, advance } = setup();
	for (let day = 0; day < 20; day++) {
		adapter.put("daily.md", `content of day ${day}`);
		adapter.put("stable.md", "never changes");
		await manager.createDailyIfMissing();
		advance(1);
	}
	const snapshots = await manager.list();
	assert.ok(snapshots.length <= 10);
	assert.equal(snapshots[snapshots.length - 1]!.date, "2026-10-20");
	// Every kept snapshot is fully readable and byte-exact.
	for (const snapshot of snapshots) {
		for (const path of Object.keys(snapshot.files)) {
			assert.ok(await manager.readFromSnapshot(snapshot, path));
		}
	}
	// Blobs of dropped snapshots are gone: one stable blob plus one per kept day.
	assert.equal(blobCount(adapter), snapshots.length + 1);
});

test("failed or partial snapshots never damage existing ones", async () => {
	const { adapter, manager, advance } = setup();
	adapter.put("n.md", "safe");
	const good = await manager.createDailyIfMissing();
	assert.ok(good);
	const before = (await manager.list()).length;

	advance(1);
	adapter.put("n.md", "changed");
	adapter.failRead = (path) => path === "n.md";
	await assert.rejects(manager.createDailyIfMissing());
	adapter.failRead = undefined;
	adapter.failWrite = (path) => path.includes("/manifests/");
	await assert.rejects(manager.createDailyIfMissing());
	adapter.failWrite = undefined;
	assert.equal((await manager.list()).length, before, "no partial snapshot");

	const retried = await manager.createDailyIfMissing();
	assert.ok(retried, "the next attempt succeeds");

	// An unreadable manifest freezes pruning and garbage collection.
	adapter.files.set(`${PLUGIN}/snapshots/manifests/broken.json`, {
		data: new TextEncoder().encode("{not json").buffer as ArrayBuffer,
		mtime: 0,
	});
	const blobs = blobCount(adapter);
	for (let day = 0; day < 15; day++) {
		advance(1);
		adapter.put("n.md", `v${day}`);
		await manager.createDailyIfMissing();
	}
	assert.ok((await manager.list()).length > 10, "nothing was pruned");
	assert.ok(blobCount(adapter) >= blobs, "no blob was collected");
});
