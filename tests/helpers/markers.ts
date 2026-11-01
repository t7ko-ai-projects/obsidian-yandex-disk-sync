import { parseMarkerLine } from "../../src/conflicts/conflict-merge";
import { splitLines } from "../../src/snapshots/line-diff";

/** Keep one side of every marker block; text outside blocks is kept as is. */
export function pickSide(text: string, side: "original" | "copy"): string {
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

/** Text as the merge code normalizes it: lines joined, one final line break. */
export function normalizeText(value: string): string {
	const lines = splitLines(value);
	return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

/** Small deterministic random source for property-style tests. */
export function randomSource(seed: number): (n: number) => number {
	let state = seed;
	return (n) => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return state % n;
	};
}
