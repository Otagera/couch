/**
 * The Library page: TV (Simkl) and films (Letterboxd) in one place, grouped
 * by where you are with them rather than by source.
 *
 *   in-progress  TV you're watching
 *   want         TV plan-to-watch + film watchlist
 *   finished     TV completed + films watched
 *   paused       TV on hold
 *   dropped      TV dropped
 *
 * Ratings are shown in each source's own scale (Simkl /10, Letterboxd stars)
 * but sorted on a common 0-10 scale.
 */

import { getDb } from "./db/index.ts";
import { listShows } from "./library.ts";
import { posterUrl } from "./tmdb.ts";
import { cachedMovie } from "./tmdbMovies.ts";

export const SHELVES = [
	"all",
	"in-progress",
	"want",
	"finished",
	"paused",
	"dropped",
] as const;
export type Shelf = (typeof SHELVES)[number];
export type KindFilter = "all" | "tv" | "film";

export interface LibraryItem {
	kind: "tv" | "film";
	key: string;
	title: string;
	year: number | null;
	shelf: Exclude<Shelf, "all">;
	/** Display rating in the source's own scale: "8/10" or "★★★★½". */
	rating: string | null;
	/** Rating on a 0-10 scale, for sorting. */
	score: number | null;
	poster: string | null;
	url: string;
	progress?: number;
	/** Last watched, or added to the watchlist. */
	activeAt: string | null;
	note: string | null;
}

const SHOW_SHELF = {
	watching: "in-progress",
	plantowatch: "want",
	completed: "finished",
	hold: "paused",
	dropped: "dropped",
} as const;

export function stars(rating: number): string {
	return "★".repeat(Math.floor(rating)) + (rating % 1 ? "½" : "");
}

export function libraryItems(): LibraryItem[] {
	const shows: LibraryItem[] = listShows().map((s) => ({
		kind: "tv",
		key: `tv-${s.simklId}`,
		title: s.title,
		year: s.year,
		shelf: SHOW_SHELF[s.status],
		rating: s.rating ? `${s.rating}/10` : null,
		score: s.rating,
		poster: s.poster,
		url: s.simklUrl,
		progress:
			s.aired && s.status !== "completed" ? s.watched / s.aired : undefined,
		activeAt: s.lastWatchedAt,
		note:
			s.status === "watching" || s.status === "hold"
				? `${s.watched}/${s.aired} eps`
				: null,
	}));

	const rows = getDb()
		.prepare(
			`SELECT key, name, year, tmdb_id, letterboxd_uri, rating, liked, watched, watched_at, watchlist, watchlist_at, rewatches
			 FROM film WHERE watched = 1 OR watchlist = 1`,
		)
		.all() as {
		key: string;
		name: string;
		year: number | null;
		tmdb_id: number | null;
		letterboxd_uri: string | null;
		rating: number | null;
		liked: number;
		watched: number;
		watched_at: string | null;
		watchlist: number;
		watchlist_at: string | null;
		rewatches: number;
	}[];
	const films: LibraryItem[] = rows.map((f) => {
		const m = f.tmdb_id ? cachedMovie(f.tmdb_id) : null;
		return {
			kind: "film",
			key: `film-${f.key}`,
			title: f.name,
			year: f.year,
			shelf: f.watched ? "finished" : "want",
			rating: f.rating
				? stars(f.rating) + (f.liked ? " ♥" : "")
				: f.liked
					? "♥"
					: null,
			score: f.rating ? f.rating * 2 : null,
			poster: posterUrl(m?.poster ?? null),
			url:
				f.letterboxd_uri ??
				(f.tmdb_id
					? `https://www.themoviedb.org/movie/${f.tmdb_id}`
					: "https://letterboxd.com"),
			activeAt: f.watched ? f.watched_at : f.watchlist_at,
			note: f.rewatches ? `rewatched ${f.rewatches}×` : null,
		};
	});

	return [...shows, ...films];
}

export function libraryView(shelf: Shelf, kind: KindFilter) {
	const all = libraryItems();
	const ofKind = kind === "all" ? all : all.filter((i) => i.kind === kind);
	const counts = Object.fromEntries(
		SHELVES.map((s) => [
			s,
			s === "all" ? ofKind.length : ofKind.filter((i) => i.shelf === s).length,
		]),
	) as Record<Shelf, number>;
	return {
		items: shelf === "all" ? ofKind : ofKind.filter((i) => i.shelf === shelf),
		counts,
	};
}
