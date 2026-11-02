/** Process-wide count of successful API responses, diffed per sync phase for diagnostics. */

let count = 0;

export function countApiResponse(): void {
	count++;
}

export function apiResponseCount(): number {
	return count;
}
