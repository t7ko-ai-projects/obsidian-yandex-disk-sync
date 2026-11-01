/**
 * Data-safety invariants for two-device synchronization.
 *
 * Every scenario uses synthetic notes only. The central invariant is that an
 * edit which was never synchronized must still exist somewhere readable
 * (a vault file, a conflict copy, a protective copy or, in plaintext mode, a
 * remote object) after the next sync, whatever happened concurrently.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { EncryptionService } from "../src/crypto/encryption";
import { computeSha256 } from "../src/utils/hash-utils";
import {
	MemoryDisk,
	bytes,
	codecFor,
	managedDevices,
	type device,
} from "./helpers/sync-flow";

type Device = ReturnType<typeof device>;

const decode = (content: ArrayBuffer) => new TextDecoder().decode(content);

/** Every readable text in the given vaults, plus plaintext remote objects. */
function everything(devices: Device[], disk: MemoryDisk, encrypted: boolean) {
	const texts: string[] = [];
	for (const d of devices) {
		for (const content of d.vault.files.values()) {
			texts.push(decode(content));
		}
	}
	if (!encrypted) {
		for (const content of disk.files.values()) {
			texts.push(decode(content));
		}
	}
	return texts;
}

function assertSurvives(
	token: string,
	devices: Device[],
	disk: MemoryDisk,
	encrypted: boolean,
	context: string,
) {
	assert.ok(
		everything(devices, disk, encrypted).some((text) =>
			text.includes(token),
		),
		`Lost unsynchronized content "${token}" (${context})`,
	);
}

/** Visible (non-plugin-data) files of a device as path -> text. */
function visible(d: Device): Record<string, string> {
	return Object.fromEntries(
		[...d.vault.files]
			.filter(([path]) => !path.startsWith(`${d.vault.configDir}/`))
			.map(([path, content]): [string, string] => [path, decode(content)])
			.sort(([a], [b]) => a.localeCompare(b)),
	);
}

/** Tokens in files whose content differs from the device's synced baseline. */
async function unsyncedTokens(d: Device, tokenOf: RegExp): Promise<string[]> {
	const tokens: string[] = [];
	const baseline = d.index.getLocalIndex().files;
	for (const [path, content] of d.vault.files) {
		if (path.startsWith(`${d.vault.configDir}/`)) {
			continue;
		}
		const entry = baseline[path];
		const sha = await computeSha256(content);
		if (entry && !entry.deleted && entry.sha256 === sha) {
			continue;
		}
		for (const match of decode(content).match(tokenOf) ?? []) {
			tokens.push(match);
		}
	}
	return tokens;
}

const BASE = ["# Title", "line one", "line two", "line three", "line four"];

for (const encrypted of [false, true]) {
	const mode = encrypted ? "encrypted" : "plain";
	// One shared codec per variant: key derivation is deliberately slow.
	const codecPromise = codecFor(encrypted);

	test(`${mode}: concurrent edits to different lines keep both edits and converge`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecPromise;
		const desktop = device(disk, "desktop", codec);
		const phone = device(disk, "phone", codec);
		desktop.vault.put("note.md", bytes(BASE.join("\n")));
		await desktop.full();
		await phone.full();

		const a = [...BASE];
		a[1] = "line one EDIT-DESKTOP";
		const b = [...BASE];
		b[3] = "line three EDIT-PHONE";
		desktop.vault.put("note.md", bytes(a.join("\n")));
		phone.vault.put("note.md", bytes(b.join("\n")));
		await desktop.full();
		await phone.full();
		await desktop.full();
		await phone.full();

		for (const token of ["EDIT-DESKTOP", "EDIT-PHONE"]) {
			assertSurvives(
				token,
				[desktop, phone],
				disk,
				encrypted,
				"disjoint",
			);
		}
		assert.deepEqual(visible(desktop), visible(phone), "devices diverged");
	});

	test(`${mode}: concurrent edits to the same line keep both edits and converge`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecPromise;
		const desktop = device(disk, "desktop", codec);
		const phone = device(disk, "phone", codec);
		desktop.vault.put("note.md", bytes(BASE.join("\n")));
		await desktop.full();
		await phone.full();
		const a = [...BASE];
		a[2] = "SAME-LINE-DESKTOP";
		const b = [...BASE];
		b[2] = "SAME-LINE-PHONE";
		desktop.vault.put("note.md", bytes(a.join("\n")));
		phone.vault.put("note.md", bytes(b.join("\n")));
		await desktop.full();
		await phone.full();
		await desktop.full();
		await phone.full();
		for (const token of ["SAME-LINE-DESKTOP", "SAME-LINE-PHONE"]) {
			assertSurvives(
				token,
				[desktop, phone],
				disk,
				encrypted,
				"same line",
			);
		}
		assert.deepEqual(visible(desktop), visible(phone));
	});

	for (const editor of ["desktop", "phone"] as const) {
		test(`${mode}: delete on one device versus offline edit on ${editor} preserves the edit`, async (t) => {
			const device = managedDevices(t);
			const disk = new MemoryDisk();
			const codec = await codecPromise;
			const desktop = device(disk, "desktop", codec);
			const phone = device(disk, "phone", codec);
			desktop.vault.put("note.md", bytes(BASE.join("\n")));
			await desktop.full();
			await phone.full();
			const deleter = editor === "desktop" ? phone : desktop;
			const edited = editor === "desktop" ? desktop : phone;
			deleter.vault.remove("note.md");
			edited.vault.put("note.md", bytes("EDIT-AFTER-DELETE"));
			// The deleting device syncs first, then the editing one.
			await deleter.full();
			await edited.full();
			await deleter.full();
			await edited.full();
			assertSurvives(
				"EDIT-AFTER-DELETE",
				[desktop, phone],
				disk,
				encrypted,
				`edit on ${editor}`,
			);
			assert.deepEqual(visible(desktop), visible(phone));
		});
	}

	test(`${mode}: an offline edit survives a remote object that went missing without a tombstone`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecPromise;
		const desktop = device(disk, "desktop", codec);
		desktop.vault.put("note.md", bytes("original"));
		await desktop.full();
		// Simulate a storage malfunction: the object disappears, the index stays.
		const physical = await desktop.client.getPhysicalPath("vault/note.md");
		assert.ok(disk.files.delete(physical), "synthetic object must exist");
		desktop.vault.put("note.md", bytes("EDIT-WHILE-REMOTE-MISSING"));
		await desktop.engine.fullSync();
		assertSurvives(
			"EDIT-WHILE-REMOTE-MISSING",
			[desktop],
			disk,
			encrypted,
			"remote object missing, local edited",
		);
	});

	test(`${mode}: an unchanged file whose remote object went missing is re-uploaded, not deleted`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecPromise;
		const desktop = device(disk, "desktop", codec);
		const phone = device(disk, "phone", codec);
		desktop.vault.put("note.md", bytes("keep me"));
		await desktop.full();
		await phone.full();
		const physical = await desktop.client.getPhysicalPath("vault/note.md");
		assert.ok(disk.files.delete(physical));
		await desktop.full();
		await phone.full();
		desktop.assertLocal("note.md", "keep me");
		phone.assertLocal("note.md", "keep me");
		assert.ok(disk.files.has(physical), "object must be repaired");
	});

	test(`${mode}: repeated syncs without changes are idempotent`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecPromise;
		const desktop = device(disk, "desktop", codec);
		const phone = device(disk, "phone", codec);
		desktop.vault.put("a.md", bytes("alpha"));
		desktop.vault.put("dir/b.md", bytes("beta"));
		await desktop.full();
		await phone.full();
		await desktop.full();
		await phone.full();
		const revision = (await desktop.canonical()).revision;
		const remote = structuredClone([...disk.files]);
		const files = visible(desktop);
		for (let i = 0; i < 3; i++) {
			await desktop.full();
			await phone.full();
		}
		assert.equal((await desktop.canonical()).revision, revision);
		assert.deepEqual([...disk.files], remote, "remote bytes changed");
		assert.deepEqual(visible(desktop), files);
		assert.deepEqual(visible(phone), files);
	});

	// Fail the Nth remote request of the sync that resolves the conflict, then
	// restart the device from its persisted state and finish.
	for (const faulty of ["first", "second"] as const) {
		test(`${mode}: failure at every request of the ${faulty} syncing device never loses an edit`, async (t) => {
			const codec = await codecPromise;
			const run = async (failAt: number | null) => {
				const device = managedDevices(t);
				const disk = new MemoryDisk();
				const desktop = device(disk, "desktop", codec);
				let phone = device(disk, "phone", codec);
				desktop.vault.put("note.md", bytes(BASE.join("\n")));
				desktop.vault.put("other.md", bytes("other"));
				await desktop.full();
				await phone.full();
				const a = [...BASE];
				a[1] = "FAULT-DESKTOP";
				const b = [...BASE];
				b[3] = "FAULT-PHONE";
				desktop.vault.put("note.md", bytes(a.join("\n")));
				phone.vault.put("note.md", bytes(b.join("\n")));

				let count = 0;
				const arm = (disk: MemoryDisk) => {
					disk.beforeRequest = async () => {
						count++;
						if (failAt !== null && count === failAt) {
							throw new Error(
								`synthetic network failure #${failAt}`,
							);
						}
					};
				};
				const order =
					faulty === "first" ? [desktop, phone] : [phone, desktop];
				let victim: Device = order[0]!;
				const other: Device = order[1]!;
				const faultyFirst = faulty === "first";
				if (faultyFirst) {
					arm(disk);
				}
				const attempt = await victim.engine.fullSync();
				disk.beforeRequest = undefined;
				if (!faultyFirst) {
					await victim.engine.fullSync();
					count = 0;
					arm(disk);
					victim = other;
					await victim.engine.fullSync();
					disk.beforeRequest = undefined;
				}
				void attempt;
				// Restart the device that saw the failure from persisted state.
				const saved = await victim.saved();
				await victim.stop();
				const restarted = device(
					disk,
					victim === desktop ? "desktop" : "phone",
					codec,
					victim.vault,
					saved,
				);
				const devices =
					victim === desktop
						? { desktop: restarted, phone }
						: { desktop, phone: restarted };
				phone = devices.phone;
				for (let i = 0; i < 4; i++) {
					await devices.desktop.engine.fullSync();
					await devices.phone.engine.fullSync();
				}
				return { disk, devices, total: count };
			};

			const clean = await run(null);
			assert.ok(clean.total > 0);
			for (let n = 1; n <= clean.total + 1; n++) {
				const { disk, devices } = await run(n);
				const both = [devices.desktop, devices.phone];
				for (const token of ["FAULT-DESKTOP", "FAULT-PHONE"]) {
					assertSurvives(
						token,
						both,
						disk,
						encrypted,
						`failure at request ${n}`,
					);
				}
				assert.deepEqual(
					visible(devices.desktop),
					visible(devices.phone),
					`devices diverged after failure at request ${n}`,
				);
			}
		});
	}
}

test("a wrong encryption password neither modifies remote data nor local files", async (t) => {
	const device = managedDevices(t);
	const disk = new MemoryDisk();
	const good = await codecFor(true);
	const desktop = device(disk, "desktop", good);
	desktop.vault.put("note.md", bytes("secret note"));
	await desktop.full();
	const wrong = new EncryptionService(new Uint8Array(16).fill(12));
	await wrong.initializeKey("a-different-synthetic-password");
	const intruder = device(disk, "intruder", wrong);
	intruder.vault.put("mine.md", bytes("local only"));
	const remote = structuredClone([...disk.files]);
	const result = await intruder.engine.fullSync().catch(() => null);
	assert.ok(
		result === null || result.success === false,
		"sync with a wrong password must not succeed",
	);
	assert.deepEqual([...disk.files], remote, "remote data was modified");
	intruder.assertLocal("mine.md", "local only");
	assert.equal(intruder.vault.files.has("note.md"), false);
});

// Seeded random interleavings of edits, deletes and syncs on two devices.
function prng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let r = Math.imul(s ^ (s >>> 15), 1 | s);
		r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
		return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
	};
}

for (const encrypted of [false, true]) {
	const seeds = encrypted ? 4 : 40;
	test(`${encrypted ? "encrypted" : "plain"}: random interleavings never lose unsynchronized edits (${seeds} seeds)`, async (t) => {
		const codec = await codecFor(encrypted);
		const paths = ["a.md", "b.md", "dir/c.md"];
		for (let seed = 1; seed <= seeds; seed++) {
			const device = managedDevices(t);
			const disk = new MemoryDisk();
			const devices = [
				device(disk, "d0", codec),
				device(disk, "d1", codec),
			];
			const rand = prng(seed);
			const trace: string[] = [];
			let counter = 0;
			devices[0]!.vault.put("a.md", bytes("TOK-0-initial"));
			await devices[0]!.full();
			await devices[1]!.full();
			for (let step = 0; step < 30; step++) {
				const which = Math.floor(rand() * 2);
				const d = devices[which]!;
				const roll = rand();
				const path = paths[Math.floor(rand() * paths.length)]!;
				if (roll < 0.4) {
					const token = `TOK-${++counter}-${seed}`;
					d.vault.put(path, bytes(`${token}\nbody`));
					trace.push(`d${which} write ${path} ${token}`);
				} else if (roll < 0.5) {
					if (d.vault.files.has(path)) {
						d.vault.remove(path);
						trace.push(`d${which} delete ${path}`);
					}
				} else {
					const pending = await unsyncedTokens(d, /TOK-\d+-\d+/g);
					trace.push(`d${which} sync pending=[${pending.join(",")}]`);
					// A first attempt may fail transiently (for example a conflict
					// resolved next to other uploads); it must succeed on retry.
					let result = await d.engine.fullSync();
					for (let retry = 0; retry < 3 && !result.success; retry++) {
						result = await d.engine.fullSync();
					}
					assert.equal(
						result.success,
						true,
						`seed ${seed}: sync kept failing ${JSON.stringify(result.errors)}\n${trace.join("\n")}`,
					);
					for (const token of pending) {
						assertSurvives(
							token,
							devices,
							disk,
							encrypted,
							`seed ${seed}\n${trace.join("\n")}`,
						);
					}
				}
			}
			// Settle: everything must converge.
			for (let i = 0; i < 4; i++) {
				for (const d of devices) {
					await d.engine.fullSync();
				}
			}
			assert.deepEqual(
				visible(devices[0]!),
				visible(devices[1]!),
				`seed ${seed}: devices diverged\n${trace.join("\n")}`,
			);
		}
	});
}
