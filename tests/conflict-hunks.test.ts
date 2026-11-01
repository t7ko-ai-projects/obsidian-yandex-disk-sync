import assert from "node:assert/strict";
import test from "node:test";
import {
	applyHunkChoices,
	copySide,
	originalSide,
	segmentChanges,
	type HunkChoice,
} from "../src/conflicts/conflict-hunks";
import { combineWithMarkers } from "../src/conflicts/conflict-merge";
import { normalizeText, pickSide, randomSource } from "./helpers/markers";

const LABELS = { original: "original", copy: "copy" };

function lines(count: number, prefix = "x"): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}

/** Text with a change in line 0 and another after `gap` untouched lines. */
function withGap(gap: number): [string, string] {
	const middle = lines(gap, "same");
	return [
		["a", ...middle, "b", "tail"].join("\n") + "\n",
		["A", ...middle, "B", "tail"].join("\n") + "\n",
	];
}

test("changes at most three equal lines apart are one section", () => {
	const count = (gap: number) =>
		segmentChanges(...withGap(gap)).segments.filter(
			(segment) => segment.kind === "change",
		).length;
	assert.equal(count(3), 1);
	assert.equal(count(4), 2);
	assert.equal(count(40), 2);
});

test("a section takes the copy, keeps the original or stays a marker block", () => {
	const [original, copy] = withGap(10);
	const segmented = segmentChanges(original, copy);
	const apply = (first: HunkChoice, second: HunkChoice) =>
		applyHunkChoices(
			segmented,
			new Map<number, HunkChoice>([
				[0, first],
				[1, second],
			]),
			LABELS,
		);
	assert.equal(apply("copy", "copy"), copy);
	assert.equal(apply("original", "original"), original);
	const mixed = apply("copy", "original");
	assert.ok(mixed.startsWith("A\n") && mixed.includes("\nb\n"));
	assert.equal(mixed.includes("CONFLICT"), false);
	const partly = apply("copy", "markers");
	assert.ok(partly.startsWith("A\n"));
	assert.equal(
		partly.split("\n").filter((line) => line.startsWith("==CONFLICT"))
			.length,
		3,
	);
});

test("undecided sections give exactly the combined text, and each side stays restorable", () => {
	const random = randomSource(11);
	const text = () =>
		Array.from({ length: random(14) }, () => `line ${random(5)}`).join(
			"\n",
		) + "\n";
	for (let i = 0; i < 300; i++) {
		const original = text();
		const copy = text();
		const segmented = segmentChanges(original, copy);
		if (normalizeText(original) !== normalizeText(copy)) {
			assert.equal(
				applyHunkChoices(segmented, new Map(), LABELS),
				combineWithMarkers(
					normalizeText(original),
					normalizeText(copy),
					LABELS,
				),
			);
		}
		const all = (choice: HunkChoice) =>
			new Map(
				segmented.segments.flatMap((segment) =>
					segment.kind === "change"
						? [[segment.id, choice] as const]
						: [],
				),
			);
		assert.equal(
			applyHunkChoices(segmented, all("copy"), LABELS),
			normalizeText(copy),
		);
		assert.equal(
			applyHunkChoices(segmented, all("original"), LABELS),
			normalizeText(original),
		);

		const choices = new Map<number, HunkChoice>();
		for (const segment of segmented.segments) {
			if (segment.kind === "change") {
				choices.set(
					segment.id,
					(["copy", "original", "markers"] as const)[random(3)]!,
				);
			}
		}
		const merged = applyHunkChoices(segmented, choices, LABELS);
		const expected = (side: "original" | "copy") =>
			segmented.segments.flatMap((segment) => {
				if (segment.kind === "same") {
					return segment.lines;
				}
				const choice = choices.get(segment.id);
				const takeCopy =
					choice === "copy" ||
					(choice === "markers" && side === "copy");
				return takeCopy
					? copySide(segment.ops)
					: originalSide(segment.ops);
			});
		const withNewline = (rows: string[]) =>
			rows.length > 0 ? rows.join("\n") + "\n" : "";
		assert.equal(
			pickSide(merged, "original"),
			withNewline(expected("original")),
		);
		assert.equal(pickSide(merged, "copy"), withNewline(expected("copy")));
	}
});
