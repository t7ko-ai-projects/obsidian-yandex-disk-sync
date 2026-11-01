import assert from "node:assert/strict";
import test from "node:test";
import {
	combineWithMarkers,
	findMarkerBlocks,
	originalOfConflictCopy,
	parseMarkerLine,
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
		const kind = parseMarkerLine(line)?.kind;
		if (kind === "start") {
			part = "original";
		} else if (part !== "none" && kind === "middle") {
			part = "copy";
		} else if (part !== "none" && kind === "end") {
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
			"==CONFLICT START: original==",
			"b",
			"==CONFLICT MIDDLE: copy==",
			"B",
			"==CONFLICT END==",
			"c",
			"d",
			"==CONFLICT START: original==",
			"==CONFLICT MIDDLE: copy==",
			"e",
			"==CONFLICT END==",
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

test("only complete marker blocks are reported, in both formats", () => {
	const block = (start: string, middle: string, end: string) =>
		[start, "x", middle, "y", end].join("\n") + "\n";
	const current = block(
		"==CONFLICT START: any label==",
		"==CONFLICT MIDDLE: other==",
		"==CONFLICT END==",
	);
	const legacy = block("<<<<<<< a", "=======", ">>>>>>> b");
	assert.deepEqual(findMarkerBlocks("no markers here\n"), []);
	assert.deepEqual(findMarkerBlocks(`t\n${current}`), [2]);
	assert.deepEqual(findMarkerBlocks(`t\n${legacy}`), [2]);
	assert.deepEqual(findMarkerBlocks(`${current}${legacy}`), [1, 6]);
	// Incomplete, out of order or mixed-format blocks are not conflicts.
	assert.deepEqual(
		findMarkerBlocks(
			"==CONFLICT START: a==\nx\n==CONFLICT MIDDLE: b==\ny\n",
		),
		[],
	);
	assert.deepEqual(
		findMarkerBlocks("==CONFLICT END==\n==CONFLICT MIDDLE: b==\n"),
		[],
	);
	assert.deepEqual(
		findMarkerBlocks(
			block("==CONFLICT START: a==", "=======", "==CONFLICT END=="),
		),
		[],
	);
	assert.deepEqual(findMarkerBlocks("=======\n>>>>>>> b\n" + legacy), [3]);
});
