/**
 * Per-section resolution of a conflict: the differences between the original
 * and the conflict copy are grouped into sections, each section can be taken
 * from the copy, kept as in the original, or left as a marker block.
 */

import type { DiffOp } from "../snapshots/line-diff";
import { diffOps, markersForOps } from "./conflict-merge";

export type HunkChoice = "copy" | "original" | "markers";

export type Segment =
	| { kind: "same"; lines: string[] }
	| { kind: "change"; id: number; ops: DiffOp[] };

export interface Segmented {
	segments: Segment[];
	/** Whether either version ended with a line break. */
	newline: boolean;
}

/** Differences closer than this many equal lines belong to one section. */
export const HUNK_CONTEXT = 3;

/** Lines of the section as the original has them. */
export function originalSide(ops: readonly DiffOp[]): string[] {
	return ops.filter((op) => op.type !== "add").map((op) => op.line);
}

/** Lines of the section as the conflict copy has them. */
export function copySide(ops: readonly DiffOp[]): string[] {
	return ops.filter((op) => op.type !== "del").map((op) => op.line);
}

/**
 * Split the edit script from `original` to `copy` into unchanged stretches and
 * change sections. Changes separated by at most `context` equal lines are one
 * section, like the hunks of a unified diff.
 */
export function segmentChanges(
	original: string,
	copy: string,
	context = HUNK_CONTEXT,
): Segmented {
	const segments: Segment[] = [];
	let same: string[] = [];
	let group: DiffOp[] | null = null;
	let gap: DiffOp[] = [];
	let id = 0;
	for (const op of diffOps(original, copy)) {
		if (op.type === "eq") {
			if (!group) {
				same.push(op.line);
				continue;
			}
			gap.push(op);
			if (gap.length > context) {
				segments.push({ kind: "change", id: id++, ops: group });
				group = null;
				same = gap.map((entry) => entry.line);
				gap = [];
			}
			continue;
		}
		if (group) {
			group.push(...gap, op);
		} else {
			if (same.length > 0) {
				segments.push({ kind: "same", lines: same });
				same = [];
			}
			group = [op];
		}
		gap = [];
	}
	if (group) {
		segments.push({ kind: "change", id: id++, ops: group });
		same = gap.map((entry) => entry.line);
	}
	if (same.length > 0) {
		segments.push({ kind: "same", lines: same });
	}
	return {
		segments,
		newline: original.endsWith("\n") || copy.endsWith("\n"),
	};
}

/**
 * Build the resolved text. A section without a choice, or with "markers", is
 * written as marker blocks so that nothing is lost and it stays findable.
 */
export function applyHunkChoices(
	{ segments, newline }: Segmented,
	choices: ReadonlyMap<number, HunkChoice>,
	labels: { original: string; copy: string },
): string {
	const out: string[] = [];
	for (const segment of segments) {
		if (segment.kind === "same") {
			out.push(...segment.lines);
			continue;
		}
		const choice = choices.get(segment.id) ?? "markers";
		if (choice === "copy") {
			out.push(...copySide(segment.ops));
		} else if (choice === "original") {
			out.push(...originalSide(segment.ops));
		} else {
			out.push(...markersForOps(segment.ops, labels));
		}
	}
	return out.length === 0 ? "" : out.join("\n") + (newline ? "\n" : "");
}
