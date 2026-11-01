/** Creates, prunes and compares daily snapshots of the whole vault. */

import { computeSha256 } from "../utils/hash-utils";
import { logger } from "../utils/logger";
import { localDateKey, selectSnapshotsToKeep } from "./retention";
import {
	compareFileMaps,
	type FileMap,
	type SnapshotChanges,
} from "./snapshot-diff";
import {
	SnapshotStore,
	type SnapshotAdapter,
	type SnapshotFileEntry,
	type SnapshotManifest,
} from "./snapshot-store";

/** Blobs younger than this survive garbage collection. */
const GARBAGE_GRACE_MS = 60 * 60 * 1000;

export interface SnapshotResult {
	manifest: SnapshotManifest;
	/** Newest earlier snapshot, the baseline of the daily summary. */
	previous: SnapshotManifest | null;
	changes: SnapshotChanges | null;
}

/**
 * Snapshot orchestration over a vault adapter. Snapshots live inside the
 * plugin's own folder, which is also what the scan skips, so they are never
 * snapshotted themselves and never synchronized.
 */
export class SnapshotManager {
	private readonly store: SnapshotStore;
	private running: Promise<unknown> | null = null;

	constructor(
		private readonly adapter: SnapshotAdapter,
		/** Plugin folder; excluded from scans because it holds credentials. */
		private readonly pluginDirectory: string,
		private readonly now: () => Date = () => new Date(),
	) {
		this.store = new SnapshotStore(adapter, `${pluginDirectory}/snapshots`);
	}

	/** Existing snapshots, oldest first. Throws when a manifest is unreadable. */
	async list(): Promise<SnapshotManifest[]> {
		const listing = await this.store.listManifests();
		if (listing.unreadable.length > 0) {
			logger.warn("Unreadable snapshot manifests ignored", {
				count: listing.unreadable.length,
			});
		}
		return listing.manifests;
	}

	/** Take today's snapshot unless one exists. Returns null when skipped. */
	async createDailyIfMissing(): Promise<SnapshotResult | null> {
		const date = localDateKey(this.now());
		const existing = await this.list();
		if (existing.some((snapshot) => snapshot.date === date)) {
			return null;
		}
		return await this.create(existing);
	}

	/** Take a snapshot now, in addition to any earlier one today. */
	async createNow(): Promise<SnapshotResult> {
		return await this.create(await this.list());
	}

	private async create(
		existing: SnapshotManifest[],
	): Promise<SnapshotResult> {
		return await this.exclusive(async () => {
			const previous = existing[existing.length - 1] ?? null;
			const time = this.now();
			const files = await this.scan(previous, true);
			const manifest: SnapshotManifest = {
				format: "vault-snapshot",
				id: `${localDateKey(time)}_${time.getTime()}`,
				date: localDateKey(time),
				createdAt: time.getTime(),
				files,
			};
			await this.store.writeManifest(manifest);
			await this.prune();
			return {
				manifest,
				previous,
				changes: previous
					? compareFileMaps(previous.files, manifest.files)
					: null,
			};
		});
	}

	/** Apply the retention policy, then reclaim unreferenced content. */
	private async prune(): Promise<void> {
		const listing = await this.store.listManifests();
		if (listing.unreadable.length > 0) {
			return;
		}
		const keep = selectSnapshotsToKeep(listing.manifests);
		for (const manifest of listing.manifests) {
			if (!keep.has(manifest.id)) {
				await this.store.deleteManifest(manifest.id);
			}
		}
		await this.store.collectGarbage(GARBAGE_GRACE_MS, this.now().getTime());
	}

	/** Changes between a snapshot and the vault as it is right now. */
	async compareWithCurrent(base: SnapshotManifest): Promise<{
		changes: SnapshotChanges;
		current: FileMap;
	}> {
		const current = await this.scan(base, false);
		return { changes: compareFileMaps(base.files, current), current };
	}

	/** Bytes of a file as stored in a snapshot, or null when absent from it. */
	async readFromSnapshot(
		snapshot: SnapshotManifest,
		path: string,
	): Promise<ArrayBuffer | null> {
		const entry = snapshot.files[path];
		return entry ? await this.store.readBlob(entry.sha256) : null;
	}

	private async exclusive<T>(work: () => Promise<T>): Promise<T> {
		if (this.running) {
			throw new Error("A snapshot operation is already running");
		}
		const run = work();
		this.running = run;
		try {
			return await run;
		} finally {
			this.running = null;
		}
	}

	/**
	 * Hash every vault file one at a time. Files unchanged in size and mtime
	 * since `previous` reuse its hash. With `store`, content is saved and the
	 * scan fails as a whole on any unreadable file: a snapshot with silently
	 * missing files must never exist.
	 */
	private async scan(
		previous: SnapshotManifest | null,
		store: boolean,
	): Promise<Record<string, SnapshotFileEntry>> {
		const files: Record<string, SnapshotFileEntry> = {};
		for (const path of await this.listVaultFiles()) {
			const stat = await this.adapter.stat(path);
			if (!stat) {
				continue;
			}
			const known = previous?.files[path];
			if (
				known &&
				known.size === stat.size &&
				known.mtime === stat.mtime &&
				(!store || (await this.store.hasBlob(known.sha256)))
			) {
				files[path] = known;
				continue;
			}
			const content = await this.adapter.readBinary(path);
			const sha256 = await computeSha256(content);
			if (store) {
				await this.store.putBlob(sha256, content);
			}
			files[path] = {
				sha256,
				size: content.byteLength,
				mtime: stat.mtime,
			};
		}
		return files;
	}

	private async listVaultFiles(): Promise<string[]> {
		const files: string[] = [];
		const visit = async (directory: string) => {
			const listed = await this.adapter.list(directory);
			for (const path of listed.files) {
				files.push(path);
			}
			for (const folder of listed.folders) {
				if (folder !== this.pluginDirectory) {
					await visit(folder);
				}
			}
		};
		await visit("");
		return files.sort();
	}
}
