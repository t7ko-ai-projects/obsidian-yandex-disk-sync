import assert from "node:assert/strict";
import test from "node:test";
import {
	combineWithMarkers,
	findMarkerBlocks,
	originalOfConflictCopy,
} from "../src/conflicts/conflict-merge";
import { normalizeText, pickSide, randomSource } from "./helpers/markers";

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
	const random = randomSource(7);
	const text = () =>
		Array.from({ length: random(12) }, () => `line ${random(6)}`).join(
			"\n",
		) + "\n";
	for (let i = 0; i < 300; i++) {
		const original = text();
		const copy = text();
		const merged = combineWithMarkers(original, copy, LABELS);
		assert.equal(
			pickSide(merged, "original"),
			normalizeText(original),
			merged,
		);
		assert.equal(pickSide(merged, "copy"), normalizeText(copy), merged);
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
