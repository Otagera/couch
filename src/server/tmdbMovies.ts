/**
 * TMDB for films: details, matching Letterboxd entries to TMDB ids, and the
 * candidate sources for film picks. Shares the request helper, list mapping
 * and provider handling with the TV client in tmdb.ts.
 */

import { config } from "./config.ts";
import { getDb } from "./db/index.ts";
import { createLogger } from "./log.ts";
import {
	listItems,
	myProviderIds,
	type RawList,
	type TmdbListItem,
	tmdb,
} from "./tmdb.ts";

const log = createLogger("tmdb");
const DETAILS_TTL_MS = 7 * 86_400_000;

export interface TmdbMovie {
	id: number;
	title: string;
	overview: string;
	releaseDate: string | null;
	genres: string[];
	directors: string[];
	cast: string[];
	keywords: string[];
	runtime: number | null;
	voteAverage: number;
	voteCount: number;
	poster: string | null;
	originalLanguage: string;
	providers: string[];
	providersLink: string | null;
}

interface RawMovie {
	id: number;
	title: string;
	overview: string;
	release_date: string | null;
	genres: { name: string }[];
	runtime: number | null;
	vote_average: number;
	vote_count: number;
	poster_path: string | null;
	original_language: string;
	keywords?: { keywords: { name: string }[] };
	credits?: {
		cast: { name: string }[];
		crew: { name: string; job: string }[];
	};
	"watch/providers"?: {
		results: Record<
			string,
			{ link?: string; flatrate?: { provider_name: string }[] }
		>;
	};
}

function slim(raw: RawMovie): TmdbMovie {
	const region = raw["watch/providers"]?.results?.[config.countryCode];
	return {
		id: raw.id,
		title: raw.title,
		overview: raw.overview ?? "",
		releaseDate: raw.release_date || null,
		genres: raw.genres?.map((g) => g.name) ?? [],
		directors:
			raw.credits?.crew
				?.filter((c) => c.job === "Director")
				.map((c) => c.name) ?? [],
		cast: raw.credits?.cast?.slice(0, 5).map((c) => c.name) ?? [],
		keywords: raw.keywords?.keywords?.slice(0, 12).map((k) => k.name) ?? [],
		runtime: raw.runtime || null,
		voteAverage: raw.vote_average ?? 0,
		voteCount: raw.vote_count ?? 0,
		poster: raw.poster_path,
		originalLanguage: raw.original_language,
		providers: region?.flatrate?.map((p) => p.provider_name) ?? [],
		providersLink: region?.link ?? null,
	};
}

export async function getMovie(
	tmdbId: number,
	maxAgeMs = DETAILS_TTL_MS,
): Promise<TmdbMovie> {
	const db = getDb();
	const row = db
		.prepare("SELECT details, fetched_at FROM tmdb_movie WHERE tmdb_id = ?")
		.get(tmdbId) as { details: string; fetched_at: string } | undefined;
	if (row && Date.now() - Date.parse(row.fetched_at) < maxAgeMs) {
		return JSON.parse(row.details) as TmdbMovie;
	}
	const movie = slim(
		await tmdb<RawMovie>(`/movie/${tmdbId}`, {
			append_to_response: "keywords,credits,watch/providers",
		}),
	);
	db.prepare(
		`INSERT INTO tmdb_movie (tmdb_id, details, fetched_at) VALUES (?, ?, ?)
		 ON CONFLICT(tmdb_id) DO UPDATE SET details = excluded.details, fetched_at = excluded.fetched_at`,
	).run(tmdbId, JSON.stringify(movie), new Date().toISOString());
	return movie;
}

export function cachedMovie(tmdbId: number): TmdbMovie | null {
	const row = getDb()
		.prepare("SELECT details FROM tmdb_movie WHERE tmdb_id = ?")
		.get(tmdbId) as { details: string } | undefined;
	return row ? (JSON.parse(row.details) as TmdbMovie) : null;
}

export async function getMovies(
	ids: number[],
	concurrency = 8,
): Promise<Map<number, TmdbMovie>> {
	const out = new Map<number, TmdbMovie>();
	const queue = [...new Set(ids)];
	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
				try {
					out.set(id, await getMovie(id));
				} catch (error) {
					log.warn("TMDB_MOVIE_FETCH_FAILED", { tmdbId: id }, error);
				}
			}
		}),
	);
	return out;
}

/**
 * Match a Letterboxd film (title + year) to a TMDB id. Letterboxd years are
 * release years, so search with the year first, then without it, preferring
 * an exact title match over TMDB's popularity order.
 */
export async function findMovieId(
	title: string,
	year: number | null,
): Promise<number | null> {
	const norm = (s: string) =>
		s
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "");
	const attempts: Record<string, string | number>[] = year
		? [
				{ query: title, primary_release_year: year },
				{ query: title, year },
			]
		: [{ query: title }];
	for (const params of attempts) {
		const res = await tmdb<{
			results: { id: number; title: string; original_title: string }[];
		}>("/search/movie", params);
		if (!res.results.length) continue;
		const exact = res.results.find(
			(r) =>
				norm(r.title) === norm(title) || norm(r.original_title) === norm(title),
		);
		return (exact ?? res.results[0]).id;
	}
	return null;
}

export async function movieRecommendationsFor(
	tmdbId: number,
): Promise<TmdbListItem[]> {
	return listItems(await tmdb<RawList>(`/movie/${tmdbId}/recommendations`));
}

export async function trendingMovies(): Promise<TmdbListItem[]> {
	return listItems(await tmdb<RawList>("/trending/movie/week"));
}

/** Well-rated films on the user's own services. */
export async function discoverMoviesOnMyServices(
	page = 1,
): Promise<TmdbListItem[]> {
	const providerIds = await myProviderIds("movie");
	if (providerIds.length === 0) return [];
	return listItems(
		await tmdb<RawList>("/discover/movie", {
			watch_region: config.countryCode,
			with_watch_providers: providerIds.join("|"),
			with_watch_monetization_types: "flatrate",
			sort_by: "vote_average.desc",
			"vote_count.gte": 800,
			page,
		}),
	);
}
