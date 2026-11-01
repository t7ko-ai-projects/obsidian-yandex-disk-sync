/** Summary of differences between two file maps. */

import type { SnapshotFileEntry } from "./snapshot-store";

export type FileMap = Readonly<Record<string, SnapshotFileEntry>>;

export interface SnapshotChanges {
	added: string[];
	modified: string[];
	deleted: string[];
	/** Same content under a new path: a deletion and an addition paired up. */
	moved: { from: string; to: string }[];
}

/**
 * Compare `before` with `after`. Identical content that disappeared from one
 * path and appeared at another, and is not ambiguous, is reported as a move
 * instead of a deletion plus an addition.
 */
export function compareFileMaps(
	before: FileMap,
	after: FileMap,
): SnapshotChanges {
	const added: string[] = [];
	const modified: string[] = [];
	const deleted: string[] = [];
	for (const [path, entry] of Object.entries(after)) {
		const old = before[path];
		if (!old) {
			added.push(path);
		} else if (old.sha256 !== entry.sha256) {
			modified.push(path);
		}
	}
	for (const path of Object.keys(before)) {
		if (!after[path]) {
			deleted.push(path);
		}
	}
	const deletedBySha = new Map<string, string[]>();
	for (const path of deleted) {
		const entry = before[path]!;
		if (entry.size === 0) {
			continue;
		}
		const list = deletedBySha.get(entry.sha256) ?? [];
		list.push(path);
		deletedBySha.set(entry.sha256, list);
	}
	const moved: { from: string; to: string }[] = [];
	const movedFrom = new Set<string>();
	const movedTo = new Set<string>();
	for (const path of added) {
		const sources = deletedBySha.get(after[path]!.sha256);
		const source = sources?.shift();
		if (source !== undefined) {
			moved.push({ from: source, to: path });
			movedFrom.add(source);
			movedTo.add(path);
		}
	}
	const byPath = (a: string, b: string) => a.localeCompare(b);
	return {
		added: added.filter((path) => !movedTo.has(path)).sort(byPath),
		modified: modified.sort(byPath),
		deleted: deleted.filter((path) => !movedFrom.has(path)).sort(byPath),
		moved: moved.sort((a, b) => byPath(a.to, b.to)),
	};
}

export function hasChanges(changes: SnapshotChanges): boolean {
	return (
		changes.added.length +
			changes.modified.length +
			changes.deleted.length +
			changes.moved.length >
		0
	);
}

const MAX_TEXT_BYTES = 1024 * 1024;

/** Decode as UTF-8 text, or null for binary, invalid or very large content. */
export function decodeText(content: ArrayBuffer): string | null {
	if (content.byteLength > MAX_TEXT_BYTES) {
		return null;
	}
	const bytes = new Uint8Array(content);
	for (let i = 0; i < Math.min(bytes.length, 8000); i++) {
		if (bytes[i] === 0) {
			return null;
		}
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}
