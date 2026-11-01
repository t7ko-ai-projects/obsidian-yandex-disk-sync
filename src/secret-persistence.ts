/**
 * Keeps the OAuth token and encryption passwords out of `data.json`.
 *
 * Secrets are written to Obsidian's secret storage just before a snapshot is
 * saved and put back right after it is loaded, so the rest of the plugin keeps
 * seeing them in settings. A secret leaves `data.json` only after it has been
 * read back from the secret storage; any doubt keeps it in the file.
 */

import type { PluginData } from "./plugin-persistence";
import { logger } from "./utils/logger";

/** The part of Obsidian's SecretStorage this plugin uses. */
export interface SecretVault {
	getSecret(id: string): string | null;
	setSecret(id: string, secret: string): void;
}

export const SECRET_IDS = {
	token: "t7-yandex-disk-sync-token",
	password: "t7-yandex-disk-sync-password",
	transitionSource: "t7-yandex-disk-sync-transition-source",
	transitionTarget: "t7-yandex-disk-sync-transition-target",
} as const;

type SecretKey = keyof typeof SECRET_IDS;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isEmpty(value: unknown): boolean {
	return value === undefined || value === null || value === "";
}

function readSecret(vault: SecretVault, key: SecretKey): string {
	try {
		return vault.getSecret(SECRET_IDS[key]) ?? "";
	} catch (error) {
		logger.warn("Secret storage read failed", { key, error });
		return "";
	}
}

/**
 * Fill secrets that `data.json` no longer holds. Values still present in the
 * file (plaintext written by an older version) win and are moved on the next
 * save. A password is restored only for the state that uses it, so a stale
 * entry can never make plaintext settings look encrypted.
 */
export function restoreSecrets(
	raw: unknown,
	vault: SecretVault | null,
): unknown {
	if (!vault || !isRecord(raw) || !isRecord(raw.settings)) {
		return raw;
	}
	const settings = { ...raw.settings };
	if (isEmpty(settings.yandexTokenSecret)) {
		const token = readSecret(vault, "token");
		if (token) {
			settings.yandexTokenSecret = token;
		}
	}
	if (
		settings.enableEncryption === true &&
		isEmpty(settings.encryptionPassword)
	) {
		const password = readSecret(vault, "password");
		if (password) {
			settings.encryptionPassword = password;
		}
	}
	const restored: Record<string, unknown> = { ...raw, settings };
	const transition = raw.encryptionTransition;
	if (isRecord(transition)) {
		const next = { ...transition };
		for (const [side, key] of [
			["source", "transitionSource"],
			["target", "transitionTarget"],
		] as const) {
			const snapshot = transition[side];
			if (
				isRecord(snapshot) &&
				snapshot.enabled === true &&
				isEmpty(snapshot.password)
			) {
				const password = readSecret(vault, key);
				if (password) {
					next[side] = { ...snapshot, password };
				}
			}
		}
		restored.encryptionTransition = next;
	}
	return restored;
}

/** Last values known to be in the secret storage, to avoid rewriting every save. */
export class SecretWriter {
	private readonly written = new Map<SecretKey, string>();

	constructor(private readonly vault: SecretVault | null) {}

	/**
	 * Return a copy of `data` without secrets that are safely stored. A secret
	 * that could not be stored and read back stays in the copy.
	 */
	strip(data: PluginData): PluginData {
		if (!this.vault) {
			return data;
		}
		const copy = JSON.parse(JSON.stringify(data)) as PluginData;
		if (this.store("token", copy.settings.yandexTokenSecret)) {
			copy.settings.yandexTokenSecret = "";
		}
		if (this.store("password", copy.settings.encryptionPassword)) {
			copy.settings.encryptionPassword = null;
		}
		const transition = copy.encryptionTransition;
		if (transition) {
			if (this.store("transitionSource", transition.source.password)) {
				transition.source.password = null;
			}
			if (this.store("transitionTarget", transition.target.password)) {
				transition.target.password = null;
			}
		} else {
			this.store("transitionSource", null);
			this.store("transitionTarget", null);
		}
		return copy;
	}

	/** True when the value is held by the secret storage (or is empty and cleared). */
	private store(key: SecretKey, value: string | null | undefined): boolean {
		const desired = value ?? "";
		if (this.written.get(key) === desired) {
			return true;
		}
		const vault = this.vault!;
		try {
			vault.setSecret(SECRET_IDS[key], desired);
			if ((vault.getSecret(SECRET_IDS[key]) ?? "") !== desired) {
				throw new Error(
					"Secret storage did not return the saved value",
				);
			}
		} catch (error) {
			this.written.delete(key);
			logger.warn("Secret kept in plugin data: secret storage failed", {
				key,
				error,
			});
			return false;
		}
		this.written.set(key, desired);
		return true;
	}
}
