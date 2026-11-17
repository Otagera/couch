export function relativeTime(iso: string | null | undefined): string {
	if (!iso) return "never";
	const then = Date.parse(iso);
	if (!Number.isFinite(then)) return "never";
	const secs = Math.round((Date.now() - then) / 1000);
	if (secs < 60) return "just now";
	const mins = Math.round(secs / 60);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.round(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days}d ago`;
	return new Date(then).toLocaleDateString(undefined, {
		month: "short",
		year: "numeric",
	});
}

/** "in 3 days", "today", "tomorrow" for an upcoming air date. */
export function untilDate(isoDate: string | null | undefined): string {
	if (!isoDate) return "";
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const days = Math.round(
		(Date.parse(`${isoDate}T00:00:00`) - today.getTime()) / 86_400_000,
	);
	if (days <= 0) return "today";
	if (days === 1) return "tomorrow";
	if (days < 7) return `in ${days} days`;
	return new Date(`${isoDate}T00:00:00`).toLocaleDateString(undefined, {
		weekday: "short",
		day: "numeric",
		month: "short",
	});
}

export const STATUS_LABEL: Record<string, string> = {
	watching: "Watching",
	plantowatch: "Plan to watch",
	hold: "On hold",
	completed: "Completed",
	dropped: "Dropped",
};
