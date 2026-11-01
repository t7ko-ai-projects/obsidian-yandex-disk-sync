/**
 * Keeps a live list of unresolved sync conflicts: conflict copies (by file
 * name) and notes holding complete conflict marker blocks (by content).
 */

import { App, Notice, Plugin, TAbstractFile, TFile } from "obsidian";
import { t } from "../i18n";
import { findMarkerBlocks, originalOfConflictCopy } from "./conflict-merge";

const MAX_SCANNED_BYTES = 2 * 1024 * 1024;
const SCAN_CHUNK = 25;
const MODIFY_DELAY_MS = 2000;

export interface ConflictCopy {
	copy: string;
	original: string;
}

export interface MarkedNote {
	path: string;
	/** One-based lines where marker blocks start. */
	blocks: number[];
}

export class ConflictTracker {
	private readonly copies = new Map<string, string>();
	private readonly marked = new Map<string, number[]>();
	private readonly listeners = new Set<() => void>();
	private readonly timers = new Map<string, number>();
	private stopped = false;
	private scanning: Promise<void> | null = null;

	constructor(
		private readonly app: App,
		private readonly plugin: Plugin,
	) {}

	/** Index existing files and follow vault events; call once the layout is ready. */
	start(): void {
		for (const file of this.app.vault.getFiles()) {
			this.noteCopy(file.path);
		}
		const vault = this.app.vault;
		this.plugin.registerEvent(vault.on("create", (f) => this.onFile(f)));
		this.plugin.registerEvent(vault.on("modify", (f) => this.onFile(f)));
		this.plugin.registerEvent(
			vault.on("delete", (f) => this.forget(f.path)),
		);
		this.plugin.registerEvent(
			vault.on("rename", (f, oldPath) => {
				this.forget(oldPath);
				this.onFile(f);
			}),
		);
		this.notify();
		void this.scan();
	}

	stop(): void {
		this.stopped = true;
		const win = window;
		for (const timer of this.timers.values()) {
			win.clearTimeout(timer);
		}
		this.timers.clear();
		this.listeners.clear();
	}

	count(): number {
		return this.copies.size + this.marked.size;
	}

	conflictCopies(): ConflictCopy[] {
		return [...this.copies]
			.map(([copy, original]) => ({ copy, original }))
			.sort((a, b) => a.original.localeCompare(b.original));
	}

	markedNotes(): MarkedNote[] {
		return [...this.marked]
			.map(([path, blocks]) => ({ path, blocks }))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Re-read every note, for when the resolver opens. */
	async refresh(): Promise<void> {
		this.copies.clear();
		for (const file of this.app.vault.getFiles()) {
			this.noteCopy(file.path);
		}
		await this.scan();
		this.notify();
	}

	/** Open the next marker block after the cursor, then in the next note. */
	async jumpToNext(): Promise<void> {
		const notes = this.markedNotes();
		if (notes.length === 0) {
			new Notice(t("conflict.none"));
			return;
		}
		const active = this.app.workspace.getActiveFile();
		const editor = this.app.workspace.activeEditor?.editor;
		if (active && editor && this.marked.has(active.path)) {
			const line = editor.getCursor().line;
			const next = findMarkerBlocks(editor.getValue()).find(
				(start) => start - 1 > line,
			);
			if (next !== undefined) {
				editor.setCursor({ line: next - 1, ch: 0 });
				editor.scrollIntoView(
					{
						from: { line: next - 1, ch: 0 },
						to: { line: next - 1, ch: 0 },
					},
					true,
				);
				return;
			}
		}
		const index = notes.findIndex((note) => note.path === active?.path);
		const target = notes[(index + 1) % notes.length]!;
		await this.open(target.path, target.blocks[0] ?? 1);
	}

	/** Open a note at a one-based line. */
	async open(path: string, line: number): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			await this.app.workspace
				.getLeaf(false)
				.openFile(file, { eState: { line: Math.max(0, line - 1) } });
		}
	}

	private noteCopy(path: string): void {
		const original = originalOfConflictCopy(path);
		if (original === null) {
			this.copies.delete(path);
		} else {
			this.copies.set(path, original);
		}
	}

	private onFile(file: TAbstractFile): void {
		if (!(file instanceof TFile)) {
			return;
		}
		const before = this.copies.size;
		this.noteCopy(file.path);
		if (this.copies.size !== before) {
			this.notify();
		}
		if (file.extension === "md") {
			this.schedule(file);
		}
	}

	private forget(path: string): void {
		const hadCopy = this.copies.delete(path);
		const hadMarkers = this.marked.delete(path);
		const timer = this.timers.get(path);
		if (timer !== undefined) {
			window.clearTimeout(timer);
			this.timers.delete(path);
		}
		if (hadCopy || hadMarkers) {
			this.notify();
		}
	}

	/** Editors save often; read a note once it has been quiet for a moment. */
	private schedule(file: TFile): void {
		const previous = this.timers.get(file.path);
		if (previous !== undefined) {
			window.clearTimeout(previous);
		}
		this.timers.set(
			file.path,
			window.setTimeout(() => {
				this.timers.delete(file.path);
				if (!this.stopped) {
					void this.check(file);
				}
			}, MODIFY_DELAY_MS),
		);
	}

	private async check(file: TFile): Promise<void> {
		if (file.stat.size > MAX_SCANNED_BYTES) {
			return;
		}
		let blocks: number[];
		try {
			blocks = findMarkerBlocks(await this.app.vault.cachedRead(file));
		} catch {
			return;
		}
		const known = this.marked.get(file.path);
		if (blocks.length === 0) {
			if (this.marked.delete(file.path)) {
				this.notify();
			}
		} else if (!known || known.join() !== blocks.join()) {
			this.marked.set(file.path, blocks);
			this.notify();
		}
	}

	/** Read all notes in small chunks so startup stays responsive. */
	private scan(): Promise<void> {
		this.scanning ??= (async () => {
			try {
				const files = this.app.vault.getMarkdownFiles();
				for (let i = 0; i < files.length && !this.stopped; i++) {
					await this.check(files[i]!);
					if (i % SCAN_CHUNK === SCAN_CHUNK - 1) {
						await new Promise((resolve) =>
							window.setTimeout(resolve, 20),
						);
					}
				}
			} finally {
				this.scanning = null;
			}
		})();
		return this.scanning;
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}
}
