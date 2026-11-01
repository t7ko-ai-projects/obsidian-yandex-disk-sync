import assert from "node:assert/strict";
import test from "node:test";
import {
	combineWithMarkers,
	findMarkerBlocks,
	MARKER_END,
	MARKER_MIDDLE,
	MARKER_START,
	originalOfConflictCopy,
} from "../src/conflicts/conflict-merge";
import { splitLines } from "../src/snapshots/line-diff";

const HASH = "a".repeat(64);
const LABELS = { original: "original", copy: "copy" };

test("conflict copy names map back to their original path", () => {
	const cases: [string, string | null][] = [
		[`note_conflict_${HASH}.md`, "note.md"],
		[`dir/sub/note_conflict_${HASH}.md`, "dir/sub/note.md"],
		[`dir/note_conflict_${HASH}_3.md`, "dir/note.md"],
		[`README_conflict_${HASH}`, "README"],
		[`my_conflict_notes_conflict_${HASH}.md`, "my_conflict_notes.md"],
		["note_conflict_abc.md", null],
		[`note_conflict_${"A".repeat(64)}.md`, null],
		["plain.md", null],
	];
	for (const [path, original] of cases) {
		assert.equal(originalOfConflictCopy(path), original, path);
	}
});

/** Keep one side of every marker block. */
function pick(text: string, side: "original" | "copy"): string {
	const out: string[] = [];
	let part: "none" | "original" | "copy" = "none";
	for (const line of splitLines(text)) {
		if (line.startsWith(MARKER_START)) {
			part = "original";
		} else if (part !== "none" && line === MARKER_MIDDLE) {
			part = "copy";
		} else if (part !== "none" && line.startsWith(MARKER_END)) {
			part = "none";
		} else if (part === "none" || part === side) {
			out.push(line);
		}
	}
	return out.length === 0 ? "" : out.join("\n") + "\n";
}

test("combining writes one marker block per differing region", () => {
	const merged = combineWithMarkers(
		"a\nb\nc\nd\n",
		"a\nB\nc\nd\ne\n",
		LABELS,
	);
	assert.equal(
		merged,
		[
			"a",
			"<<<<<<< original",
			"b",
			"=======",
			"B",
			">>>>>>> copy",
			"c",
			"d",
			"<<<<<<< original",
			"=======",
			"e",
			">>>>>>> copy",
			"",
		].join("\n"),
	);
	assert.deepEqual(findMarkerBlocks(merged), [2, 9]);
	assert.equal(combineWithMarkers("same\n", "same\n", LABELS), "same\n");
});

test("choosing one side of every block restores that version exactly", () => {
	let seed = 7;
	const random = (n: number) => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed % n;
	};
	const text = () =>
		Array.from({ length: random(12) }, () => `line ${random(6)}`).join(
			"\n",
		) + "\n";
	for (let i = 0; i < 300; i++) {
		const original = text();
		const copy = text();
		const merged = combineWithMarkers(original, copy, LABELS);
		const normalize = (value: string) =>
			splitLines(value).length === 0
				? ""
				: splitLines(value).join("\n") + "\n";
		assert.equal(pick(merged, "original"), normalize(original), merged);
		assert.equal(pick(merged, "copy"), normalize(copy), merged);
	}
});

test("only complete marker blocks are reported", () => {
	assert.deepEqual(findMarkerBlocks("no markers here\n"), []);
	assert.deepEqual(findMarkerBlocks("<<<<<<< a\nx\n=======\ny\n"), []);
	assert.deepEqual(
		findMarkerBlocks("t\n<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n"),
		[2],
	);
	assert.deepEqual(
		findMarkerBlocks(
			"=======\n>>>>>>> b\n<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n",
		),
		[3],
	);
});
