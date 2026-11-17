/**
 * The user's TV library: Simkl rows joined with cached TMDB details, and the
 * "up next" view built from them.
 */

import { config } from "./config.ts";
import { getDb } from "./db/index.ts";
import { type ShowStatus, simklUrl } from "./simkl.ts";
import { cachedShow, getShows, posterUrl } from "./tmdb.ts";

export interface LibraryShow {
	simklId: number;
	tmdbId: number | null;
	title: string;
	year: number | null;
	status: ShowStatus;
	rating: number | null;
	lastWatchedAt: string | null;
	lastWatched: string | null;
	nextToWatch: string | null;
	watched: number;
	total: number;
	notAired: number;
	simklUrl: string;
	poster: string | null;
	genres: string[];
	providers: string[];
	nextAirDate: string | null;
	tmdbStatus: string | null;
}

interface ShowRow {
	simkl_id: number;
	slug: string;
	title: string;
	year: number | null;
	tmdb_id: number | null;
	status: ShowStatus;
	user_rating: number | null;
	last_watched_at: string | null;
	last_watched: string | null;
	next_to_watch: string | null;
	watched_episodes: number;
	total_episodes: number;
	not_aired: number;
}

function toLibraryShow(r: ShowRow): LibraryShow {
	const t = r.tmdb_id ? cachedShow(r.tmdb_id) : null;
	return {
		simklId: r.simkl_id,
		tmdbId: r.tmdb_id,
		title: r.title,
		year: r.year,
		status: r.status,
		rating: r.user_rating,
		lastWatchedAt: r.last_watched_at,
		lastWatched: r.last_watched,
		nextToWatch: r.next_to_watch,
		watched: r.watched_episodes,
		total: r.total_episodes,
		notAired: r.not_aired,
		simklUrl: simklUrl(r.simkl_id, r.slug),
		poster: posterUrl(t?.poster ?? null),
		genres: t?.genres ?? [],
		providers: t?.providers ?? [],
		nextAirDate: t?.nextEpisode?.airDate ?? null,
		tmdbStatus: t?.status ?? null,
	};
}

export function listShows(status?: ShowStatus): LibraryShow[] {
	const db = getDb();
	const rows = (status
		? db
				.prepare("SELECT * FROM show WHERE status = ? ORDER BY title")
				.all(status)
		: db
				.prepare("SELECT * FROM show ORDER BY title")
				.all()) as unknown as ShowRow[];
	return rows.map(toLibraryShow);
}

export function libraryTmdbIds(): Set<number> {
	const rows = getDb()
		.prepare("SELECT tmdb_id FROM show WHERE tmdb_id IS NOT NULL")
		.all() as {
		tmdb_id: number;
	}[];
	return new Set(rows.map((r) => r.tmdb_id));
}

/**
 * Refresh TMDB details for the shows that "up next" reasons about: anything
 * in progress, paused or finished (finished shows can get new seasons).
 */
export async function refreshLibraryDetails(): Promise<number> {
	const rows = getDb()
		.prepare(
			"SELECT tmdb_id FROM show WHERE tmdb_id IS NOT NULL AND status IN ('watching','hold','completed','plantowatch')",
		)
		.all() as { tmdb_id: number }[];
	const shows = await getShows(rows.map((r) => r.tmdb_id));
	return shows.size;
}

export interface UpNext {
	/** Watching, with an episode ready, most recently watched first. */
	continueWatching: LibraryShow[];
	/** Watching, but nothing watched for a while. */
	stalled: LibraryShow[];
	/** Finished or paused shows that have new aired episodes. */
	newEpisodes: LibraryShow[];
	/** Shows you follow with an episode airing in the next 30 days. */
	comingSoon: LibraryShow[];
}

export function upNext(now = Date.now()): UpNext {
	const all = listShows();
	const stalledBefore = now - config.stalledAfterDays * 86_400_000;
	const soon = now + 30 * 86_400_000;
	const watchedAt = (s: LibraryShow) =>
		s.lastWatchedAt ? Date.parse(s.lastWatchedAt) : 0;
	const byRecent = (a: LibraryShow, b: LibraryShow) =>
		watchedAt(b) - watchedAt(a);

	const watching = all.filter((s) => s.status === "watching");
	const hasUnwatched = (s: LibraryShow) => s.total > 0 && s.watched < s.total;

	return {
		continueWatching: watching
			.filter((s) => hasUnwatched(s) && watchedAt(s) >= stalledBefore)
			.sort(byRecent),
		stalled: watching
			.filter((s) => hasUnwatched(s) && watchedAt(s) < stalledBefore)
			.sort(byRecent),
		newEpisodes: all
			.filter(
				(s) =>
					(s.status === "completed" || s.status === "hold") && hasUnwatched(s),
			)
			.sort(byRecent),
		comingSoon: all
			.filter((s) => {
				if (
					!["watching", "completed", "hold"].includes(s.status) ||
					!s.nextAirDate
				)
					return false;
				const t = Date.parse(s.nextAirDate);
				return t >= now - 86_400_000 && t <= soon;
			})
			.sort((a, b) => (a.nextAirDate ?? "").localeCompare(b.nextAirDate ?? "")),
	};
}

export function libraryStats() {
	const rows = getDb()
		.prepare("SELECT status, COUNT(*) AS n FROM show GROUP BY status")
		.all() as {
		status: ShowStatus;
		n: number;
	}[];
	return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Partial<
		Record<ShowStatus, number>
	>;
}
