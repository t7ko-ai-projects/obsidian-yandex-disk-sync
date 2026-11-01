/** Diff of a conflict split into sections, each with its own decision buttons. */

import { t } from "../i18n";
import {
	HUNK_CONTEXT,
	type HunkChoice,
	type Segmented,
} from "../conflicts/conflict-hunks";

const MARKS = { add: "+", del: "-", eq: " " } as const;

function addLine(
	container: HTMLElement,
	type: keyof typeof MARKS,
	line: string,
): void {
	container.createDiv({
		cls: `ydsync-diff-line ydsync-diff-${type}`,
		text: `${MARKS[type]} ${line}`,
	});
}

/** Unchanged lines around a section: a few lines of context, the rest elided. */
function addContext(
	container: HTMLElement,
	lines: readonly string[],
	position: "first" | "middle" | "last",
): void {
	const limit = HUNK_CONTEXT;
	const gap = () =>
		container.createDiv({ cls: "ydsync-diff-hunk", text: "..." });
	if (position === "first") {
		if (lines.length > limit) {
			gap();
		}
		lines.slice(-limit).forEach((line) => addLine(container, "eq", line));
	} else if (position === "last") {
		lines.slice(0, limit).forEach((line) => addLine(container, "eq", line));
		if (lines.length > limit) {
			gap();
		}
	} else if (lines.length <= 2 * limit) {
		lines.forEach((line) => addLine(container, "eq", line));
	} else {
		lines.slice(0, limit).forEach((line) => addLine(container, "eq", line));
		gap();
		lines.slice(-limit).forEach((line) => addLine(container, "eq", line));
	}
}

/**
 * Render every change section with "take" and "reject" buttons. A button
 * pressed again clears the decision. `onChange` runs after each decision.
 */
export function renderHunks(
	container: HTMLElement,
	{ segments }: Segmented,
	choices: Map<number, HunkChoice>,
	onChange: () => void,
): void {
	const total = segments.filter(
		(segment) => segment.kind === "change",
	).length;
	let number = 0;
	segments.forEach((segment, index) => {
		if (segment.kind === "same") {
			addContext(
				container,
				segment.lines,
				index === 0
					? "first"
					: index === segments.length - 1
						? "last"
						: "middle",
			);
			return;
		}
		number++;
		const section = container.createDiv({ cls: "ydsync-hunk" });
		const bar = section.createDiv({ cls: "ydsync-hunk-actions" });
		bar.createSpan({
			text: t("conflict.hunk_title", {
				number: String(number),
				total: String(total),
			}),
		});
		const buttons: [HunkChoice, string][] = [
			["copy", t("conflict.take_change")],
			["original", t("conflict.reject_change")],
		];
		const refresh = () => {
			for (const [choice, button] of pressed) {
				const on = choices.get(segment.id) === choice;
				button.toggleClass("mod-cta", on);
				button.setAttribute("aria-pressed", String(on));
			}
		};
		const pressed: [HunkChoice, HTMLButtonElement][] = [];
		for (const [choice, label] of buttons) {
			const button = bar.createEl("button", {
				text: label,
				attr: { type: "button", "aria-pressed": "false" },
			});
			pressed.push([choice, button]);
			button.addEventListener("click", () => {
				if (choices.get(segment.id) === choice) {
					choices.delete(segment.id);
				} else {
					choices.set(segment.id, choice);
				}
				refresh();
				onChange();
			});
		}
		refresh();
		for (const op of segment.ops) {
			addLine(section, op.type, op.line);
		}
	});
}
