/** Conflict copy naming and two-way "combine with markers" merging. */

import { diffLines, splitLines } from "../snapshots/line-diff";

export const MARKER_START = "<<<<<<< ";
export const MARKER_MIDDLE = "=======";
export const MARKER_END = ">>>>>>> ";

/** `<name>_conflict_<64 hex>[_<n>][.<ext>]`, as written by the conflict settlement. */
const CONFLICT_COPY = /^(.+)_conflict_[0-9a-f]{64}(?:_\d+)?(\.[^./]+)?$/;

/** Path of the file a conflict copy belongs to, or null when it is not one. */
export function originalOfConflictCopy(path: string): string | null {
	const slash = path.lastIndexOf("/");
	const directory = slash >= 0 ? path.slice(0, slash + 1) : "";
	const match = CONFLICT_COPY.exec(path.slice(slash + 1));
	return match ? `${directory}${match[1]}${match[2] ?? ""}` : null;
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
	const before = splitLines(original);
	const after = splitLines(copy);
	const ops = diffLines(before, after) ?? [
		...before.map((line) => ({ type: "del" as const, line })),
		...after.map((line) => ({ type: "add" as const, line })),
	];
	const out: string[] = [];
	let mine: string[] = [];
	let theirs: string[] = [];
	const flush = () => {
		if (mine.length === 0 && theirs.length === 0) {
			return;
		}
		out.push(`${MARKER_START}${labels.original}`, ...mine);
		out.push(MARKER_MIDDLE, ...theirs);
		out.push(`${MARKER_END}${labels.copy}`);
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
	const newline = original.endsWith("\n") || copy.endsWith("\n");
	return out.join("\n") + (newline ? "\n" : "");
}

/** One-based line numbers where a complete marker block starts. */
export function findMarkerBlocks(text: string): number[] {
	if (!text.includes(MARKER_START)) {
		return [];
	}
	const starts: number[] = [];
	let start = 0;
	let middle = false;
	splitLines(text).forEach((line, index) => {
		if (line.startsWith(MARKER_START)) {
			start = index + 1;
			middle = false;
		} else if (start > 0 && line === MARKER_MIDDLE) {
			middle = true;
		} else if (start > 0 && middle && line.startsWith(MARKER_END)) {
			starts.push(start);
			start = 0;
			middle = false;
		}
	});
	return starts;
}
