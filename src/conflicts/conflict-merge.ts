/** Conflict copy naming and two-way "combine with markers" merging. */

import { diffLines, splitLines, type DiffOp } from "../snapshots/line-diff";

/**
 * Marker lines are Obsidian highlights, so they show up in every view and
 * cannot be read as Markdown headings or quotes. Detection relies on the
 * fixed keywords only; the text after the colon is a display label.
 */
const START = /^==CONFLICT START(?::.*)?==$/;
const MIDDLE = /^==CONFLICT MIDDLE(?::.*)?==$/;
const END = /^==CONFLICT END==$/;
/** Git-style markers written by version 2.4.0, still recognised. */
const LEGACY_START = /^<<<<<<< /;
const LEGACY_MIDDLE = /^=======$/;
const LEGACY_END = /^>>>>>>> /;

export type MarkerKind = "start" | "middle" | "end";

/** Classify a line as a marker line of the current or the legacy format. */
export function parseMarkerLine(
	line: string,
): { kind: MarkerKind; legacy: boolean } | null {
	for (const [kind, current, legacy] of [
		["start", START, LEGACY_START],
		["middle", MIDDLE, LEGACY_MIDDLE],
		["end", END, LEGACY_END],
	] as const) {
		if (current.test(line)) {
			return { kind, legacy: false };
		}
		if (legacy.test(line)) {
			return { kind, legacy: true };
		}
	}
	return null;
}

/** `<name>_conflict_<64 hex>[_<n>][.<ext>]`, as written by the conflict settlement. */
const CONFLICT_COPY = /^(.+)_conflict_[0-9a-f]{64}(?:_\d+)?(\.[^./]+)?$/;

/** Path of the file a conflict copy belongs to, or null when it is not one. */
export function originalOfConflictCopy(path: string): string | null {
	const slash = path.lastIndexOf("/");
	const directory = slash >= 0 ? path.slice(0, slash + 1) : "";
	const match = CONFLICT_COPY.exec(path.slice(slash + 1));
	return match ? `${directory}${match[1]}${match[2] ?? ""}` : null;
}

/** Line edit script from the original to the copy; one big change when too large to diff. */
export function diffOps(original: string, copy: string): DiffOp[] {
	const before = splitLines(original);
	const after = splitLines(copy);
	return (
		diffLines(before, after) ?? [
			...before.map((line) => ({ type: "del" as const, line })),
			...after.map((line) => ({ type: "add" as const, line })),
		]
	);
}

/**
 * Lines for an edit script where every region that differs becomes a marker
 * block (original lines, then copy lines) and equal lines stay once.
 */
export function markersForOps(
	ops: readonly DiffOp[],
	labels: { original: string; copy: string },
): string[] {
	const out: string[] = [];
	let mine: string[] = [];
	let theirs: string[] = [];
	const flush = () => {
		if (mine.length === 0 && theirs.length === 0) {
			return;
		}
		out.push(`==CONFLICT START: ${labels.original}==`, ...mine);
		out.push(`==CONFLICT MIDDLE: ${labels.copy}==`, ...theirs);
		out.push("==CONFLICT END==");
		mine = [];
		theirs = [];
	};
	for (const op of ops) {
		if (op.type === "eq") {
			flush();
			out.push(op.line);
		} else if (op.type === "del") {
			mine.push(op.line);
		} else {
			theirs.push(op.line);
		}
	}
	flush();
	return out;
}

/**
 * Merge two versions of a text without a common ancestor. Identical lines are
 * kept once; each region where the versions differ is written as a marker
 * block holding the original's lines, then the copy's lines. Keeping only the
 * first halves of all blocks gives back the original, only the second halves
 * the copy.
 */
export function combineWithMarkers(
	original: string,
	copy: string,
	labels: { original: string; copy: string },
): string {
	if (original === copy) {
		return original;
	}
	const out = markersForOps(diffOps(original, copy), labels);
	const newline = original.endsWith("\n") || copy.endsWith("\n");
	return out.join("\n") + (newline ? "\n" : "");
}

/** One-based line numbers where a complete marker block starts. */
export function findMarkerBlocks(text: string): number[] {
	if (!text.includes("CONFLICT START") && !text.includes("<<<<<<< ")) {
		return [];
	}
	const starts: number[] = [];
	let start = 0;
	let legacy = false;
	let middle = false;
	splitLines(text).forEach((line, index) => {
		const marker = parseMarkerLine(line);
		if (marker?.kind === "start") {
			start = index + 1;
			legacy = marker.legacy;
			middle = false;
		} else if (
			start > 0 &&
			marker?.kind === "middle" &&
			marker.legacy === legacy
		) {
			middle = true;
		} else if (
			start > 0 &&
			middle &&
			marker?.kind === "end" &&
			marker.legacy === legacy
		) {
			starts.push(start);
			start = 0;
			middle = false;
		}
	});
	return starts;
}
