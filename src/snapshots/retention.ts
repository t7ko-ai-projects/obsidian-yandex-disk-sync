/** Retention policy for daily vault snapshots. */

export const DAILY_SNAPSHOT_COUNT = 7;
export const WEEKLY_SNAPSHOT_COUNT = 3;

export interface SnapshotRef {
	id: string;
	/** Local calendar date, `YYYY-MM-DD`. */
	date: string;
	createdAt: number;
}

/** Format a local calendar date without time-zone conversion. */
export function localDateKey(time: Date): string {
	const month = String(time.getMonth() + 1).padStart(2, "0");
	const day = String(time.getDate()).padStart(2, "0");
	return `${time.getFullYear()}-${month}-${day}`;
}

/** Monday of the ISO week that contains the given `YYYY-MM-DD` date. */
export function isoWeekStart(date: string): string {
	const [year, month, day] = date.split("-").map(Number) as [
		number,
		number,
		number,
	];
	const utc = new Date(Date.UTC(year, month - 1, day));
	const sinceMonday = (utc.getUTCDay() + 6) % 7;
	utc.setUTCDate(utc.getUTCDate() - sinceMonday);
	return utc.toISOString().slice(0, 10);
}

/**
 * Choose the snapshots to keep from whatever exists, independent of gaps.
 *
 * Daily tier: the newest snapshot of each of the 7 most recent dates that have
 * one. Weekly tier: among the remaining snapshots, the newest of each ISO week,
 * for the 3 most recent such weeks. Missing days never shrink either tier, and
 * the result is recomputed from the listing alone, so a missed run changes
 * nothing. Never drops the only snapshot of a date out of the daily tier.
 */
export function selectSnapshotsToKeep(
	snapshots: readonly SnapshotRef[],
): Set<string> {
	const newestPerDate = new Map<string, SnapshotRef>();
	for (const snapshot of snapshots) {
		const current = newestPerDate.get(snapshot.date);
		if (
			!current ||
			snapshot.createdAt > current.createdAt ||
			(snapshot.createdAt === current.createdAt &&
				snapshot.id > current.id)
		) {
			newestPerDate.set(snapshot.date, snapshot);
		}
	}
	const byDateDesc = [...newestPerDate.values()].sort((a, b) =>
		a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
	);
	const keep = new Set<string>();
	for (const snapshot of byDateDesc.slice(0, DAILY_SNAPSHOT_COUNT)) {
		keep.add(snapshot.id);
	}
	const seenWeeks = new Set<string>();
	for (const snapshot of byDateDesc.slice(DAILY_SNAPSHOT_COUNT)) {
		const week = isoWeekStart(snapshot.date);
		if (seenWeeks.has(week)) {
			continue;
		}
		if (seenWeeks.size >= WEEKLY_SNAPSHOT_COUNT) {
			break;
		}
		seenWeeks.add(week);
		keep.add(snapshot.id);
	}
	return keep;
}
