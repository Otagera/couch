/**
 * TMDB: metadata, posters, "more like this" and where-to-watch for TV.
 *
 * Details are cached in SQLite for a few days. Air dates move (that is how
 * we spot new seasons), so the cache is short rather than permanent.
 */

import { config, requireConfig } from "./config.ts";
import { getDb } from "./db/index.ts";
import { createLogger } from "./log.ts";

const log = createLogger("tmdb");

const API = "https://api.themoviedb.org/3";
const IMAGE = "https://image.tmdb.org/t/p";
const DETAILS_TTL_MS = 3 * 86_400_000;

export interface Episode {
	airDate: string | null;
	season: number;
	episode: number;
}

export interface TmdbShow {
	id: number;
	name: string;
	overview: string;
	firstAirDate: string | null;
	lastAirDate: string | null;
	status: string; // "Returning Series", "Ended", ...
	genres: string[];
	networks: string[];
	creators: string[];
	cast: string[];
	keywords: string[];
	seasons: number;
	episodeRuntime: number | null;
	voteAverage: number;
	voteCount: number;
	poster: string | null;
	nextEpisode: Episode | null;
	lastEpisode: Episode | null;
	/** Streaming (flatrate) providers in the configured country. */
	providers: string[];
	providersLink: string | null;
}

export interface TmdbListItem {
	id: number;
	name: string;
	overview: string;
	firstAirDate: string | null;
	genreIds: number[];
	voteAverage: number;
	voteCount: number;
	poster: string | null;
	originalLanguage: string;
}

export async function tmdb<T>(
	path: string,
	params: Record<string, string | number> = {},
): Promise<T> {
	const u = new URL(`${API}${path}`);
	u.searchParams.set("api_key", requireConfig("tmdbApiKey", "TMDB_API_KEY"));
	for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
	const res = await fetch(u, { signal: AbortSignal.timeout(15_000) });
	if (!res.ok) throw new Error(`TMDB ${res.status} on ${path}`);
	return (await res.json()) as T;
}

export function posterUrl(
	path: string | null,
	size: "w185" | "w342" | "w500" = "w342",
): string | null {
	return path ? `${IMAGE}/${size}${path}` : null;
}

// --------------------------------------------------------------- details

interface RawEpisode {
	air_date: string | null;
	season_number: number;
	episode_number: number;
}

interface RawDetails {
	id: number;
	name: string;
	overview: string;
	first_air_date: string | null;
	last_air_date: string | null;
	status: string;
	genres: { name: string }[];
	networks: { name: string }[];
	created_by: { name: string }[];
	number_of_seasons: number;
	episode_run_time: number[];
	vote_average: number;
	vote_count: number;
	poster_path: string | null;
	next_episode_to_air: RawEpisode | null;
	last_episode_to_air: RawEpisode | null;
	keywords?: { results: { name: string }[] };
	aggregate_credits?: { cast: { name: string }[] };
	"watch/providers"?: {
		results: Record<
			string,
			{ link?: string; flatrate?: { provider_name: string }[] }
		>;
	};
}

const episode = (e: RawEpisode | null): Episode | null =>
	e
		? {
				airDate: e.air_date,
				season: e.season_number,
				episode: e.episode_number,
			}
		: null;

function slim(raw: RawDetails): TmdbShow {
	const region = raw["watch/providers"]?.results?.[config.countryCode];
	return {
		id: raw.id,
		name: raw.name,
		overview: raw.overview ?? "",
		firstAirDate: raw.first_air_date || null,
		lastAirDate: raw.last_air_date || null,
		status: raw.status,
		genres: raw.genres?.map((g) => g.name) ?? [],
		networks: raw.networks?.map((n) => n.name) ?? [],
		creators: raw.created_by?.map((c) => c.name) ?? [],
		cast: raw.aggregate_credits?.cast?.slice(0, 6).map((c) => c.name) ?? [],
		keywords: raw.keywords?.results?.slice(0, 12).map((k) => k.name) ?? [],
		seasons: raw.number_of_seasons ?? 0,
		episodeRuntime: raw.episode_run_time?.[0] ?? null,
		voteAverage: raw.vote_average ?? 0,
		voteCount: raw.vote_count ?? 0,
		poster: raw.poster_path,
		nextEpisode: episode(raw.next_episode_to_air),
		lastEpisode: episode(raw.last_episode_to_air),
		providers: region?.flatrate?.map((p) => p.provider_name) ?? [],
		providersLink: region?.link ?? null,
	};
}

/** Show details, from cache when fresh. */
export async function getShow(
	tmdbId: number,
	maxAgeMs = DETAILS_TTL_MS,
): Promise<TmdbShow> {
	const db = getDb();
	const row = db
		.prepare("SELECT details, fetched_at FROM tmdb_show WHERE tmdb_id = ?")
		.get(tmdbId) as { details: string; fetched_at: string } | undefined;
	if (row && Date.now() - Date.parse(row.fetched_at) < maxAgeMs) {
		return JSON.parse(row.details) as TmdbShow;
	}
	const raw = await tmdb<RawDetails>(`/tv/${tmdbId}`, {
		append_to_response: "keywords,aggregate_credits,watch/providers",
	});
	const show = slim(raw);
	db.prepare(
		`INSERT INTO tmdb_show (tmdb_id, details, fetched_at) VALUES (?, ?, ?)
		 ON CONFLICT(tmdb_id) DO UPDATE SET details = excluded.details, fetched_at = excluded.fetched_at`,
	).run(tmdbId, JSON.stringify(show), new Date().toISOString());
	return show;
}

export function cachedShow(tmdbId: number): TmdbShow | null {
	const row = getDb()
		.prepare("SELECT details FROM tmdb_show WHERE tmdb_id = ?")
		.get(tmdbId) as { details: string } | undefined;
	return row ? (JSON.parse(row.details) as TmdbShow) : null;
}

/** Fetch several shows with modest concurrency (TMDB allows ~40 req/s). */
export async function getShows(
	ids: number[],
	concurrency = 8,
): Promise<Map<number, TmdbShow>> {
	const out = new Map<number, TmdbShow>();
	const queue = [...new Set(ids)];
	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
				try {
					out.set(id, await getShow(id));
				} catch (error) {
					// One missing show should not sink a whole run.
					log.warn("TMDB_SHOW_FETCH_FAILED", { tmdbId: id }, error);
				}
			}
		}),
	);
	return out;
}

// ------------------------------------------------------------- discovery

/**
 * TV and movie list results differ only in field names (name/title,
 * first_air_date/release_date). Both map onto TmdbListItem, so the picks
 * pipeline treats them alike; for films, `name` is the title and
 * `firstAirDate` the release date.
 */
export interface RawList {
	results: Array<{
		id: number;
		name?: string;
		title?: string;
		overview: string;
		first_air_date?: string;
		release_date?: string;
		genre_ids: number[];
		vote_average: number;
		vote_count: number;
		poster_path: string | null;
		original_language: string;
	}>;
}

export const listItems = (raw: RawList): TmdbListItem[] =>
	raw.results.map((r) => ({
		id: r.id,
		name: r.name ?? r.title ?? "",
		overview: r.overview,
		firstAirDate: r.first_air_date || r.release_date || null,
		genreIds: r.genre_ids,
		voteAverage: r.vote_average,
		voteCount: r.vote_count,
		poster: r.poster_path,
		originalLanguage: r.original_language,
	}));

export async function recommendationsFor(
	tmdbId: number,
): Promise<TmdbListItem[]> {
	return listItems(await tmdb<RawList>(`/tv/${tmdbId}/recommendations`));
}

export async function trending(): Promise<TmdbListItem[]> {
	return listItems(await tmdb<RawList>("/trending/tv/week"));
}

/** Well-rated shows on the user's own services. */
export async function discoverOnMyServices(page = 1): Promise<TmdbListItem[]> {
	const providerIds = await myProviderIds("tv");
	if (providerIds.length === 0) return [];
	return listItems(
		await tmdb<RawList>("/discover/tv", {
			watch_region: config.countryCode,
			with_watch_providers: providerIds.join("|"),
			with_watch_monetization_types: "flatrate",
			sort_by: "vote_average.desc",
			"vote_count.gte": 300,
			page,
		}),
	);
}

export type MediaKind = "tv" | "movie";

const providerCache = new Map<MediaKind, { id: number; name: string }[]>();

export async function availableProviders(
	kind: MediaKind = "tv",
): Promise<{ id: number; name: string }[]> {
	const cached = providerCache.get(kind);
	if (cached) return cached;
	const raw = await tmdb<{
		results: { provider_id: number; provider_name: string }[];
	}>(`/watch/providers/${kind}`, { watch_region: config.countryCode });
	const list = raw.results.map((p) => ({
		id: p.provider_id,
		name: p.provider_name,
	}));
	providerCache.set(kind, list);
	return list;
}

export async function myProviderIds(kind: MediaKind): Promise<number[]> {
	if (config.services.length === 0) return [];
	return (await availableProviders(kind))
		.filter((p) => config.services.includes(p.name.toLowerCase()))
		.map((p) => p.id);
}

/** True when any of the show's providers is one of the user's services. */
export function onMyServices(providers: string[]): boolean {
	return providers.some((p) => config.services.includes(p.toLowerCase()));
}

/** Match a show name (from a file path) to a TMDB TV id. */
export async function findShowId(
	title: string,
	year: number | null,
): Promise<number | null> {
	const norm = (s: string) =>
		s
			.normalize("NFKD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "");
	const attempts: Record<string, string | number>[] = year
		? [{ query: title, first_air_date_year: year }, { query: title }]
		: [{ query: title }];
	for (const params of attempts) {
		const res = await tmdb<{
			results: { id: number; name: string; original_name: string }[];
		}>("/search/tv", params);
		if (!res.results.length) continue;
		const exact = res.results.find(
			(r) =>
				norm(r.name) === norm(title) || norm(r.original_name) === norm(title),
		);
		return (exact ?? res.results[0]).id;
	}
	return null;
}
