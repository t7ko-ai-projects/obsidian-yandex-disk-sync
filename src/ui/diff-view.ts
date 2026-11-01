/** Shared rendering of a line diff between two stored file versions. */

import { t } from "../i18n";
import { diffLines, splitLines, toHunks } from "../snapshots/line-diff";
import { decodeText } from "../snapshots/snapshot-diff";

/** Render a line diff of two file versions into `output`; absent means empty. */
export function renderTextDiff(
	output: HTMLElement,
	before: ArrayBuffer | null,
	after: ArrayBuffer | null,
): void {
	const textBefore = before ? decodeText(before) : "";
	const textAfter = after ? decodeText(after) : "";
	if (textBefore === null || textAfter === null) {
		output.setText(
			t("snapshot.binary", {
				before: String(before?.byteLength ?? 0),
				after: String(after?.byteLength ?? 0),
			}),
		);
		return;
	}
	const ops = diffLines(splitLines(textBefore), splitLines(textAfter));
	if (ops === null) {
		output.setText(t("snapshot.diff_too_large"));
		return;
	}
	for (const hunk of toHunks(ops)) {
		output.createDiv({
			cls: "ydsync-diff-hunk",
			text: `@@ -${hunk.oldStart} +${hunk.newStart} @@`,
		});
		for (const op of hunk.ops) {
			const mark =
				op.type === "add" ? "+" : op.type === "del" ? "-" : " ";
			output.createDiv({
				cls: `ydsync-diff-line ydsync-diff-${op.type}`,
				text: `${mark} ${op.line}`,
			});
		}
	}
}
