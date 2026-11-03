import assert from "node:assert/strict";
import test from "node:test";
import {
	MemoryDisk,
	bytes,
	codecFor,
	managedDevices,
} from "./helpers/sync-flow";

for (const encrypted of [false, true]) {
	{
		test(`${encrypted ? "encrypted" : "plaintext"} realtime edit lost to a delete stays as a visible synced copy`, async (t) => {
			const make = managedDevices(t);
			const disk = new MemoryDisk();
			const codec = await codecFor(encrypted);
			const a = make(disk, "device-a", codec);
			const b = make(disk, "device-b", await codecFor(encrypted));
			a.vault.put("note.md", bytes("base"));
			await a.full();
			await b.full();

			// Device a deletes while device b is offline and edits the file.
			a.vault.remove("note.md");
			await a.full();
			b.vault.put("note.md", bytes("edit after delete"));
			await b.engine.syncFileBatch([
				{
					id: "edit-note",
					action: "upload" as const,
					path: "note.md",
					createdAt: 1,
					epoch: b.index.getObservedEpoch(),
					baseRevision: b.index.getLocalIndex().observedRevision,
				},
			]);
			await b.full();
			await a.full();

			const copies = (device: typeof a) =>
				[...device.vault.files.keys()].filter((name) =>
					name.startsWith("note_conflict_"),
				);
			assert.equal(a.vault.files.has("note.md"), false);
			assert.equal(b.vault.files.has("note.md"), false);
			assert.equal(
				copies(b).length,
				1,
				"copy kept on the editing device",
			);
			assert.deepEqual(
				copies(a),
				copies(b),
				"copy reached the other device",
			);
			await a.assertSettled({ [copies(a)[0]!]: "edit after delete" });
			await b.assertSettled({ [copies(b)[0]!]: "edit after delete" });
		});
	}
}
