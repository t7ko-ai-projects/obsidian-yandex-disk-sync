import assert from "node:assert/strict";
import test from "node:test";
import { loadPluginData, PLUGIN_DATA_FORMAT } from "../src/plugin-data-loader";
import type { PluginData } from "../src/plugin-persistence";
import {
	restoreSecrets,
	SECRET_IDS,
	SecretWriter,
	type SecretVault,
} from "../src/secret-persistence";
import { DEFAULT_SETTINGS } from "../src/types";
import { localSnapshot, localTransition } from "./helpers/crypto-fixtures";

class MemoryVault implements SecretVault {
	readonly values = new Map<string, string>();
	getSecret(id: string): string | null {
		return this.values.get(id) ?? null;
	}
	setSecret(id: string, secret: string): void {
		this.values.set(id, secret);
	}
}

/** A store that accepts writes but never returns them. */
class ForgetfulVault implements SecretVault {
	getSecret(): string | null {
		return null;
	}
	setSecret(): void {}
}

function encryptedData(withTransition: boolean): PluginData {
	return {
		format: PLUGIN_DATA_FORMAT,
		settings: {
			...DEFAULT_SETTINGS,
			yandexTokenSecret: "oauth-token",
			enableEncryption: true,
			encryptionSalt: "target",
			encryptionPassword: "target-password",
			encryptionRevision: 2,
			encryptionProfileId: "hardened",
		},
		localState: null,
		pendingMutations: [],
		pendingPhysicalActions: [],
		pendingWatcherEvents: [],
		encryptionTransition: withTransition
			? localTransition({
					phase: "files-copied",
					source: localSnapshot("source", "source-password", 1),
					target: localSnapshot("target", "target-password", 2),
					sourceRawPaths: ["old"],
					targetRawByLogicalPath: { "note.md": "new" },
					sourceFingerprints: { old: "sha256:old" },
					targetFingerprints: { new: "sha256:new" },
				})
			: null,
		forceRecovery: null,
		lastSyncStats: { uploaded: 0, downloaded: 0, deleted: 0, errors: 0 },
	};
}

/** What storage would hold: JSON, as written to and read from data.json. */
function viaDisk(data: PluginData): unknown {
	return JSON.parse(JSON.stringify(data));
}

test("secrets leave data.json and come back intact, including a transition", () => {
	const vault = new MemoryVault();
	const original = encryptedData(true);
	const persisted = new SecretWriter(vault).strip(original);

	assert.equal(persisted.settings.yandexTokenSecret, "");
	assert.equal(persisted.settings.encryptionPassword, null);
	assert.equal(persisted.encryptionTransition?.source.password, null);
	assert.equal(persisted.encryptionTransition?.target.password, null);
	assert.equal(JSON.stringify(persisted).includes("password"), true);
	for (const secret of [
		"oauth-token",
		"target-password",
		"source-password",
	]) {
		assert.equal(JSON.stringify(persisted).includes(secret), false, secret);
	}
	assert.equal(original.settings.encryptionPassword, "target-password");

	const loaded = loadPluginData(
		restoreSecrets(viaDisk(persisted), vault) as PluginData,
	);
	assert.deepEqual(loaded, original);
});

test("a missing secret never turns an encrypted vault into a plaintext one", () => {
	const vault = new MemoryVault();
	const persisted = new SecretWriter(vault).strip(encryptedData(false));
	vault.values.clear();

	const loaded = loadPluginData(
		restoreSecrets(viaDisk(persisted), vault) as PluginData,
	);
	assert.equal(loaded?.settings.enableEncryption, true);
	assert.equal(loaded?.settings.encryptionPassword, null);
	assert.equal(loaded?.settings.yandexTokenSecret, "");
});

test("a store that does not keep values leaves the secrets in data.json", () => {
	const persisted = new SecretWriter(new ForgetfulVault()).strip(
		encryptedData(true),
	);
	assert.equal(persisted.settings.yandexTokenSecret, "oauth-token");
	assert.equal(persisted.settings.encryptionPassword, "target-password");
	assert.equal(
		persisted.encryptionTransition?.source.password,
		"source-password",
	);
});

test("plaintext written by an older version wins over the store and is migrated", () => {
	const vault = new MemoryVault();
	vault.values.set(SECRET_IDS.token, "stale-token");
	const older = viaDisk(encryptedData(false));
	const loaded = loadPluginData(
		restoreSecrets(older, vault) as PluginData,
	) as PluginData;
	assert.equal(loaded.settings.yandexTokenSecret, "oauth-token");

	const persisted = new SecretWriter(vault).strip(loaded);
	assert.equal(persisted.settings.yandexTokenSecret, "");
	assert.equal(vault.values.get(SECRET_IDS.token), "oauth-token");
});

test("disabling encryption clears the stored password and a stale one is ignored", () => {
	const vault = new MemoryVault();
	const writer = new SecretWriter(vault);
	writer.strip(encryptedData(false));
	assert.equal(vault.values.get(SECRET_IDS.password), "target-password");

	const disabled = encryptedData(false);
	Object.assign(disabled.settings, {
		enableEncryption: false,
		encryptionSalt: null,
		encryptionPassword: null,
		encryptionRevision: null,
		encryptionProfileId: null,
	});
	const persisted = writer.strip(disabled);
	assert.equal(vault.values.get(SECRET_IDS.password), "");

	vault.values.set(SECRET_IDS.password, "stale-password");
	const loaded = loadPluginData(
		restoreSecrets(viaDisk(persisted), vault) as PluginData,
	);
	assert.equal(loaded?.settings.encryptionPassword, null);
});
