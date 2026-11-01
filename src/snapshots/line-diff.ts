/** Line-based diff (Myers) used to show what changed between snapshots. */

export type DiffOp = { type: "eq" | "add" | "del"; line: string };

const MAX_LINES = 20000;
const MAX_EDIT_DISTANCE = 1500;

/** Split text into lines, keeping an empty final line out of the result. */
export function splitLines(text: string): string[] {
	if (text === "") {
		return [];
	}
	const lines = text.split(/\r?\n/);
	if (lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

/**
 * Compute a shortest edit script between two line arrays. Returns null when
 * the inputs are too large or too different to diff within bounded memory.
 */
export function diffLines(
	before: readonly string[],
	after: readonly string[],
): DiffOp[] | null {
	if (before.length > MAX_LINES || after.length > MAX_LINES) {
		return null;
	}
	let start = 0;
	while (
		start < before.length &&
		start < after.length &&
		before[start] === after[start]
	) {
		start++;
	}
	let endBefore = before.length;
	let endAfter = after.length;
	while (
		endBefore > start &&
		endAfter > start &&
		before[endBefore - 1] === after[endAfter - 1]
	) {
		endBefore--;
		endAfter--;
	}
	const a = before.slice(start, endBefore);
	const b = after.slice(start, endAfter);
	const middle = myers(a, b);
	if (middle === null) {
		return null;
	}
	return [
		...before
			.slice(0, start)
			.map((line) => ({ type: "eq" as const, line })),
		...middle,
		...before
			.slice(endBefore)
			.map((line) => ({ type: "eq" as const, line })),
	];
}

function myers(a: string[], b: string[]): DiffOp[] | null {
	const n = a.length;
	const m = b.length;
	if (n === 0) {
		return b.map((line) => ({ type: "add", line }));
	}
	if (m === 0) {
		return a.map((line) => ({ type: "del", line }));
	}
	const max = Math.min(n + m, MAX_EDIT_DISTANCE);
	const offset = max + 1;
	let v = new Int32Array(2 * max + 3);
	const trace: Int32Array[] = [];
	let found = -1;
	for (let d = 0; d <= max && found < 0; d++) {
		trace.push(v.slice());
		const next = v.slice();
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (
				k === -d ||
				(k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
			) {
				x = v[offset + k + 1]!;
			} else {
				x = v[offset + k - 1]! + 1;
			}
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			next[offset + k] = x;
			if (x >= n && y >= m) {
				found = d;
				break;
			}
		}
		v = next;
	}
	if (found < 0) {
		return null;
	}
	const ops: DiffOp[] = [];
	let x = n;
	let y = m;
	for (let d = found; d > 0; d--) {
		const previous = trace[d]!;
		const k = x - y;
		const goDown =
			k === -d ||
			(k !== d && previous[offset + k - 1]! < previous[offset + k + 1]!);
		const prevK = goDown ? k + 1 : k - 1;
		const prevX = previous[offset + prevK]!;
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			ops.push({ type: "eq", line: a[x - 1]! });
			x--;
			y--;
		}
		if (goDown) {
			ops.push({ type: "add", line: b[y - 1]! });
			y--;
		} else {
			ops.push({ type: "del", line: a[x - 1]! });
			x--;
		}
	}
	while (x > 0 && y > 0) {
		ops.push({ type: "eq", line: a[x - 1]! });
		x--;
		y--;
	}
	return ops.reverse();
}

export interface DiffHunk {
	/** One-based first line in the old text. */
	oldStart: number;
	/** One-based first line in the new text. */
	newStart: number;
	ops: DiffOp[];
}

/** Group an edit script into hunks with surrounding context lines. */
export function toHunks(ops: readonly DiffOp[], context = 3): DiffHunk[] {
	const hunks: DiffHunk[] = [];
	let oldLine = 1;
	let newLine = 1;
	let current: DiffHunk | null = null;
	let trailingEq = 0;
	const pendingContext: { op: DiffOp; old: number; new: number }[] = [];
	for (const op of ops) {
		if (op.type === "eq") {
			if (current) {
				if (trailingEq < context) {
					current.ops.push(op);
					trailingEq++;
				} else {
					hunks.push(current);
					current = null;
					pendingContext.length = 0;
					pendingContext.push({ op, old: oldLine, new: newLine });
				}
			} else {
				pendingContext.push({ op, old: oldLine, new: newLine });
				if (pendingContext.length > context) {
					pendingContext.shift();
				}
			}
			oldLine++;
			newLine++;
			continue;
		}
		if (!current) {
			const first = pendingContext[0];
			current = {
				oldStart: first ? first.old : oldLine,
				newStart: first ? first.new : newLine,
				ops: pendingContext.map((entry) => entry.op),
			};
			pendingContext.length = 0;
		}
		trailingEq = 0;
		current.ops.push(op);
		if (op.type === "del") {
			oldLine++;
		} else {
			newLine++;
		}
	}
	if (current) {
		hunks.push(current);
	}
	return hunks;
}
