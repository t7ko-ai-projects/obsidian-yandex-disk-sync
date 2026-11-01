/**
 * Content-addressed storage for vault snapshots.
 *
 * Layout under the root: `blobs/<xx>/<sha256>` hold file bytes once, however
 * many snapshots reference them; `manifests/<id>.json` describe one snapshot.
 * Blobs and manifests are written to a temporary name and renamed, and a
 * manifest is written only after all its blobs exist, so a crash leaves at
 * worst unreferenced blobs.
 */

import type { DataAdapter } from "obsidian";
import { computeSha256 } from "../utils/hash-utils";
import type { SnapshotRef } from "./retention";

export type SnapshotAdapter = Pick<
	DataAdapter,
	| "exists"
	| "mkdir"
	| "list"
	| "readBinary"
	| "writeBinary"
	| "rename"
	| "remove"
	| "stat"
>;

export interface SnapshotFileEntry {
	sha256: string;
	size: number;
	mtime: number;
}

export interface SnapshotManifest extends SnapshotRef {
	format: "vault-snapshot";
	files: Record<string, SnapshotFileEntry>;
}

export interface ManifestListing {
	manifests: SnapshotManifest[];
	/** Manifest files that exist but could not be validated. */
	unreadable: string[];
}

const SHA256 = /^[0-9a-f]{64}$/;
const TEMP_MARKER = ".tmp-";

/** Strictly validate a parsed manifest; returns null when it is not trustworthy. */
export function parseManifest(
	value: unknown,
	fileId: string,
): SnapshotManifest | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const record = value as Record<string, unknown>;
	if (
		record.format !== "vault-snapshot" ||
		record.id !== fileId ||
		typeof record.date !== "string" ||
		!/^\d{4}-\d{2}-\d{2}$/.test(record.date) ||
		typeof record.createdAt !== "number" ||
		!Number.isFinite(record.createdAt) ||
		typeof record.files !== "object" ||
		record.files === null ||
		Array.isArray(record.files)
	) {
		return null;
	}
	const files: Record<string, SnapshotFileEntry> = Object.create(
		null,
	) as Record<string, SnapshotFileEntry>;
	for (const [path, entry] of Object.entries(record.files)) {
		const item = entry as Record<string, unknown> | null;
		if (
			typeof item !== "object" ||
			item === null ||
			typeof item.sha256 !== "string" ||
			!SHA256.test(item.sha256) ||
			typeof item.size !== "number" ||
			typeof item.mtime !== "number"
		) {
			return null;
		}
		files[path] = {
			sha256: item.sha256,
			size: item.size,
			mtime: item.mtime,
		};
	}
	return {
		format: "vault-snapshot",
		id: fileId,
		date: record.date,
		createdAt: record.createdAt,
		files,
	};
}

export class SnapshotStore {
	constructor(
		private readonly adapter: SnapshotAdapter,
		private readonly root: string,
	) {}

	private blobDir(sha256: string): string {
		return `${this.root}/blobs/${sha256.slice(0, 2)}`;
	}

	private blobPath(sha256: string): string {
		return `${this.blobDir(sha256)}/${sha256}`;
	}

	private manifestPath(id: string): string {
		return `${this.root}/manifests/${id}.json`;
	}

	private async ensureDirectory(path: string): Promise<void> {
		if (!(await this.adapter.exists(path))) {
			await this.adapter.mkdir(path);
		}
	}

	private async writeAtomic(
		path: string,
		content: ArrayBuffer,
	): Promise<void> {
		const temporary = `${path}${TEMP_MARKER}${Math.random().toString(36).slice(2)}`;
		await this.adapter.writeBinary(temporary, content);
		try {
			await this.adapter.rename(temporary, path);
		} catch (error) {
			await this.adapter.remove(temporary).catch(() => undefined);
			throw error;
		}
	}

	async hasBlob(sha256: string): Promise<boolean> {
		return await this.adapter.exists(this.blobPath(sha256));
	}

	/** Store bytes under their hash; the caller guarantees `sha256` matches. */
	async putBlob(sha256: string, content: ArrayBuffer): Promise<void> {
		if (await this.hasBlob(sha256)) {
			return;
		}
		await this.ensureDirectory(this.root);
		await this.ensureDirectory(`${this.root}/blobs`);
		await this.ensureDirectory(this.blobDir(sha256));
		await this.writeAtomic(this.blobPath(sha256), content);
	}

	/** Read bytes and verify them against their address. */
	async readBlob(sha256: string): Promise<ArrayBuffer> {
		const content = await this.adapter.readBinary(this.blobPath(sha256));
		if ((await computeSha256(content)) !== sha256) {
			throw new Error("Snapshot content is corrupted");
		}
		return content;
	}

	async writeManifest(manifest: SnapshotManifest): Promise<void> {
		await this.ensureDirectory(this.root);
		await this.ensureDirectory(`${this.root}/manifests`);
		const bytes = new TextEncoder().encode(JSON.stringify(manifest));
		await this.writeAtomic(this.manifestPath(manifest.id), bytes.buffer);
	}

	async deleteManifest(id: string): Promise<void> {
		await this.adapter.remove(this.manifestPath(id));
	}

	async listManifests(): Promise<ManifestListing> {
		const directory = `${this.root}/manifests`;
		if (!(await this.adapter.exists(directory))) {
			return { manifests: [], unreadable: [] };
		}
		const listed = await this.adapter.list(directory);
		const manifests: SnapshotManifest[] = [];
		const unreadable: string[] = [];
		for (const path of listed.files) {
			const name = path.slice(path.lastIndexOf("/") + 1);
			if (name.includes(TEMP_MARKER) || !name.endsWith(".json")) {
				continue;
			}
			const id = name.slice(0, -".json".length);
			try {
				const text = new TextDecoder("utf-8", { fatal: true }).decode(
					await this.adapter.readBinary(path),
				);
				const manifest = parseManifest(JSON.parse(text), id);
				if (manifest) {
					manifests.push(manifest);
				} else {
					unreadable.push(name);
				}
			} catch {
				unreadable.push(name);
			}
		}
		manifests.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
		return { manifests, unreadable };
	}

	/**
	 * Delete blobs no manifest references. Refuses to run when any manifest is
	 * unreadable, and spares anything newer than the grace period so a snapshot
	 * that is still being written is never damaged.
	 */
	async collectGarbage(graceMs: number, now: number): Promise<number> {
		const listing = await this.listManifests();
		if (listing.unreadable.length > 0) {
			return 0;
		}
		const referenced = new Set<string>();
		for (const manifest of listing.manifests) {
			for (const entry of Object.values(manifest.files)) {
				referenced.add(entry.sha256);
			}
		}
		const blobRoot = `${this.root}/blobs`;
		if (!(await this.adapter.exists(blobRoot))) {
			return 0;
		}
		let removed = 0;
		for (const folder of (await this.adapter.list(blobRoot)).folders) {
			for (const path of (await this.adapter.list(folder)).files) {
				const name = path.slice(path.lastIndexOf("/") + 1);
				const orphan = name.includes(TEMP_MARKER)
					? true
					: !referenced.has(name);
				if (!orphan) {
					continue;
				}
				const stat = await this.adapter.stat(path);
				if (stat && now - stat.mtime < graceMs) {
					continue;
				}
				await this.adapter.remove(path);
				removed++;
			}
		}
		return removed;
	}
}
