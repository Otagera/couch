/**
 * Picks: what to watch next, for TV (from Simkl) or films (from Letterboxd).
 *
 *   1. Candidates, no LLM: TMDB "recommendations" for the user's best-rated
 *      titles, well-rated titles on their services, this week's trending,
 *      and (films) their own watchlist. Anything already watched, in the TV
 *      library, or rejected before is dropped.
 *   2. A cheap pre-rank (how many favourites point at it, plus TMDB score)
 *      trims the pool to ~60, which get full details and providers.
 *   3. One call to a strong model with the shared taste profile chooses the
 *      picks and explains each in terms of the user's own history.
 *
 * `dryRunPicks` runs steps 1-2 and returns the exact prompt step 3 would
 * send, without calling the model.
 */

import { config } from "./config.ts";
import { getDb } from "./db/index.ts";
import { filmSeeds, watchedFilmTmdbIds, watchlistTmdbIds } from "./films.ts";
import { libraryTmdbIds } from "./library.ts";
import { type ChatMessage, chat, parseJson } from "./llm.ts";
import { createLogger } from "./log.ts";
import { localMovies, localShows } from "./media/index.ts";
import { buildProfile, getProfile, profileIsStale } from "./taste.ts";
import {
	discoverOnMyServices,
	getShows,
	type MediaKind,
	onMyServices,
	posterUrl,
	recommendationsFor,
	type TmdbListItem,
	type TmdbShow,
	trending,
} from "./tmdb.ts";
import {
	discoverMoviesOnMyServices,
	getMovies,
	movieRecommendationsFor,
	type TmdbMovie,
	trendingMovies,
} from "./tmdbMovies.ts";

const log = createLogger("picks");

const POOL_SIZE = 60;
const PICK_COUNT = 8;
const MAX_SEEDS = 15;

export type { MediaKind };

export interface Candidate {
	item: TmdbListItem;
	/** The user's favourites whose TMDB recommendations included this one. */
	because: Set<string>;
	sources: Set<string>;
	/** Films only: already on the user's watchlist and streaming for them. */
	watchlistOnServices?: boolean;
	/** On one of the user's own drives. */
	local?: boolean;
}

function showSeeds(): { tmdbId: number; title: string }[] {
	// Best-rated first; unrated completed shows still say something.
	return getDb()
		.prepare(
			`SELECT tmdb_id AS tmdbId, title FROM show
			 WHERE tmdb_id IS NOT NULL AND status IN ('completed','watching')
			   AND (user_rating IS NULL OR user_rating >= 7)
			 ORDER BY user_rating DESC NULLS LAST, last_watched_at DESC
			 LIMIT ?`,
		)
		.all(MAX_SEEDS) as { tmdbId: number; title: string }[];
}

function rejectedIds(kind: MediaKind): Set<number> {
	const rows = getDb()
		.prepare(
			`SELECT DISTINCT p.tmdb_id FROM pick p JOIN pick_run r ON r.id = p.run_id
			 WHERE p.feedback < 0 AND r.kind = ?`,
		)
		.all(kind) as { tmdb_id: number }[];
	return new Set(rows.map((r) => r.tmdb_id));
}

const movieAsItem = (m: TmdbMovie): TmdbListItem => ({
	id: m.id,
	name: m.title,
	overview: m.overview,
	firstAirDate: m.releaseDate,
	genreIds: [],
	voteAverage: m.voteAverage,
	voteCount: m.voteCount,
	poster: m.poster,
	originalLanguage: m.originalLanguage,
});

export async function gatherCandidates(kind: MediaKind): Promise<Candidate[]> {
	const exclude = new Set(
		kind === "tv"
			? [...libraryTmdbIds(), ...rejectedIds("tv")]
			: [...watchedFilmTmdbIds(), ...rejectedIds("movie")],
	);
	const pool = new Map<number, Candidate>();
	const add = (item: TmdbListItem, source: string, because?: string) => {
		if (exclude.has(item.id)) return;
		const c = pool.get(item.id) ?? {
			item,
			because: new Set<string>(),
			sources: new Set<string>(),
		};
		c.sources.add(source);
		if (because) c.because.add(because);
		pool.set(item.id, c);
	};
	const addAll = (source: string) => (items: TmdbListItem[]) => {
		for (const i of items) add(i, source);
	};

	const seeds = kind === "tv" ? showSeeds() : filmSeeds(MAX_SEEDS);
	const recs = kind === "tv" ? recommendationsFor : movieRecommendationsFor;
	const discover =
		kind === "tv" ? discoverOnMyServices : discoverMoviesOnMyServices;
	const jobs: Promise<unknown>[] = [
		...seeds.map(async (s) => {
			for (const item of await recs(s.tmdbId)) add(item, "similar", s.title);
		}),
		discover(1).then(addAll("my-services")),
		discover(2).then(addAll("my-services")),
		(kind === "tv" ? trending() : trendingMovies()).then(addAll("trending")),
	];
	if (kind === "movie") {
		jobs.push(
			getMovies(watchlistTmdbIds()).then((movies) => {
				for (const m of movies.values()) {
					add(movieAsItem(m), "watchlist");
					const c = pool.get(m.id);
					if (c && onMyServices(m.providers)) c.watchlistOnServices = true;
				}
			}),
		);
	}
	// Titles on the user's drives that they haven't watched are candidates too.
	const localIds =
		kind === "tv" ? [...localShows().keys()] : [...localMovies().keys()];
	const unseenLocal = localIds.filter((id) => !exclude.has(id));
	if (unseenLocal.length) {
		jobs.push(
			kind === "tv"
				? getShows(unseenLocal.slice(0, 40)).then((shows) => {
						for (const d of shows.values())
							add(
								{
									id: d.id,
									name: d.name,
									overview: d.overview,
									firstAirDate: d.firstAirDate,
									genreIds: [],
									voteAverage: d.voteAverage,
									voteCount: d.voteCount,
									poster: d.poster,
									originalLanguage: "",
								},
								"local",
							);
					})
				: getMovies(unseenLocal.slice(0, 40)).then((movies) => {
						for (const m of movies.values()) add(movieAsItem(m), "local");
					}),
		);
	}
	const settled = await Promise.allSettled(jobs);
	const localSet = new Set(localIds);
	for (const c of pool.values()) if (localSet.has(c.item.id)) c.local = true;
	const failed = settled.filter((s) => s.status === "rejected");
	if (failed.length === settled.length) {
		throw new Error(
			`Could not fetch any candidates from TMDB: ${(failed[0] as PromiseRejectedResult).reason}`,
		);
	}
	return [...pool.values()];
}

export function preRank(candidates: Candidate[]): Candidate[] {
	const score = (c: Candidate) =>
		c.because.size * 2 +
		(c.sources.has("my-services") ? 1.5 : 0) +
		(c.watchlistOnServices ? 3 : c.sources.has("watchlist") ? 0.5 : 0) +
		(c.local ? 2 : 0) +
		(c.item.voteCount >= 100 ? c.item.voteAverage / 5 : 0);
	return [...candidates]
		.sort((a, b) => score(b) - score(a))
		.slice(0, POOL_SIZE);
}

function providersText(providers: string[], local = false): string {
	if (local)
		return `ON THEIR OWN DRIVE${providers.length ? ` (also streams on ${providers.join(", ")})` : ""}`;
	if (onMyServices(providers))
		return `ON THEIR SERVICES: ${providers.join(", ")}`;
	return providers.length
		? `streams on ${providers.join(", ")}`
		: "no streaming in their country";
}

function describeShow(c: Candidate, d: TmdbShow | undefined): string {
	const year = (d?.firstAirDate ?? c.item.firstAirDate)?.slice(0, 4) ?? "?";
	const parts = [
		`[${c.item.id}] ${c.item.name} (${year})`,
		d?.genres.length ? d.genres.join("/") : null,
		d?.networks[0] ?? null,
		d ? `${d.seasons} season${d.seasons === 1 ? "" : "s"}, ${d.status}` : null,
		d?.episodeRuntime ? `${d.episodeRuntime}min eps` : null,
		`TMDB ${c.item.voteAverage.toFixed(1)} (${c.item.voteCount} votes)`,
		d
			? providersText(d.providers, c.local)
			: c.local
				? "ON THEIR OWN DRIVE"
				: null,
		c.because.size
			? `similar to their: ${[...c.because].slice(0, 4).join(", ")}`
			: null,
		d?.creators.length ? `by ${d.creators.join(", ")}` : null,
		d?.keywords.length ? `themes: ${d.keywords.slice(0, 6).join(", ")}` : null,
	];
	const overview = (d?.overview || c.item.overview)
		.replace(/\s+/g, " ")
		.slice(0, 260);
	return `${parts.filter(Boolean).join(" | ")}\n  ${overview}`;
}

function describeMovie(c: Candidate, d: TmdbMovie | undefined): string {
	const year = (d?.releaseDate ?? c.item.firstAirDate)?.slice(0, 4) ?? "?";
	const parts = [
		`[${c.item.id}] ${c.item.name} (${year})`,
		d?.genres.length ? d.genres.join("/") : null,
		d?.directors.length ? `dir. ${d.directors.join(", ")}` : null,
		d?.runtime ? `${d.runtime}min` : null,
		`TMDB ${c.item.voteAverage.toFixed(1)} (${c.item.voteCount} votes)`,
		d
			? providersText(d.providers, c.local)
			: c.local
				? "ON THEIR OWN DRIVE"
				: null,
		c.sources.has("watchlist") ? "ON THEIR WATCHLIST" : null,
		c.because.size
			? `similar to their: ${[...c.because].slice(0, 4).join(", ")}`
			: null,
		d?.cast.length ? `with ${d.cast.slice(0, 3).join(", ")}` : null,
		d?.keywords.length ? `themes: ${d.keywords.slice(0, 6).join(", ")}` : null,
	];
	const overview = (d?.overview || c.item.overview)
		.replace(/\s+/g, " ")
		.slice(0, 260);
	return `${parts.filter(Boolean).join(" | ")}\n  ${overview}`;
}

function systemPrompt(kind: MediaKind): string {
	const noun = kind === "tv" ? "TV shows" : "films";
	const extra =
		kind === "movie"
			? "\nFilms marked ON THEIR WATCHLIST are ones they already want to see: include one or two if they fit, and say so.\n"
			: "";
	return `You choose ${noun} for one specific viewer.
You get their taste profile and a numbered list of candidate ${noun} they have not watched.
Choose exactly ${PICK_COUNT} from the list. Only choose ids that appear in the list.

Prefer ${noun} on their streaming services or their own drive, but up to 2 picks may be elsewhere if they are an
unusually strong match. Mix safe bets with one or two less obvious choices. Avoid near-duplicates.
${extra}
For each pick write one or two sentences, addressed to the viewer, saying why it suits them,
grounded in their actual history (name shows or films they liked). No plot summaries, no hype.

Reply with JSON only: {"picks":[{"id":123,"reason":"..."}]} ordered best first.`;
}

async function prepare(kind: MediaKind, profileText: string) {
	const pool = preRank(await gatherCandidates(kind));
	if (pool.length === 0) {
		throw new Error(
			kind === "tv"
				? "No candidates found. Sync your Simkl library first."
				: "No candidates found. Import your Letterboxd export or set LETTERBOXD_USERNAME, then sync.",
		);
	}
	const ids = pool.map((c) => c.item.id);
	const lines =
		kind === "tv"
			? await getShows(ids).then((d) =>
					pool.map((c) => describeShow(c, d.get(c.item.id))),
				)
			: await getMovies(ids).then((d) =>
					pool.map((c) => describeMovie(c, d.get(c.item.id))),
				);
	const messages: ChatMessage[] = [
		{ role: "system", content: systemPrompt(kind) },
		{
			role: "user",
			content: `# Taste profile\n${profileText}\n\n# Their streaming services\n${
				config.services.join(", ") || "not set"
			} (country ${config.countryCode})\n\n# Candidates\n${lines.join("\n")}`,
		},
	];
	return { pool, messages };
}

export interface DryRun {
	kind: MediaKind;
	model: string;
	candidates: number;
	profileStale: boolean;
	messages: ChatMessage[];
	/** Rough size: about 4 characters per token. */
	approxInputTokens: number;
}

/** Everything a pick run would send, without calling any model. */
export async function dryRunPicks(
	kind: MediaKind,
	model = config.pickModel,
): Promise<DryRun> {
	const profile = getProfile();
	const profileText =
		profile?.text ??
		"(No taste profile yet. A real run writes one first from your history; see `taste`.)";
	const { pool, messages } = await prepare(kind, profileText);
	const chars = messages.reduce((n, m) => n + m.content.length, 0);
	return {
		kind,
		model,
		candidates: pool.length,
		profileStale: profileIsStale(),
		messages,
		approxInputTokens: Math.round(chars / 4),
	};
}

export interface PickRun {
	runId: number;
	candidates: number;
	costUsd: number | null;
}

export async function runPicks(
	kind: MediaKind = "tv",
	model = config.pickModel,
): Promise<PickRun> {
	const { profile } = await buildProfile();
	const { pool, messages } = await prepare(kind, profile.text);
	const result = await chat(model, messages, {
		json: true,
		maxTokens: 2500,
	});

	const parsed = parseJson<{ picks?: { id: number; reason: string }[] }>(
		result.text,
	);
	const byId = new Map(pool.map((c) => [c.item.id, c]));
	const picks = (parsed.picks ?? []).filter(
		(p) => byId.has(Number(p.id)) && p.reason,
	);
	if (picks.length === 0)
		throw new Error("The model returned no usable picks. Try again.");

	const db = getDb();
	db.exec("BEGIN");
	try {
		const { lastInsertRowid } = db
			.prepare(
				"INSERT INTO pick_run (created_at, model, candidates, note, kind) VALUES (?, ?, ?, ?, ?)",
			)
			.run(
				new Date().toISOString(),
				result.model,
				pool.length,
				JSON.stringify({
					costUsd: result.costUsd,
					profileCostUsd: profile.costUsd,
				}),
				kind,
			);
		const insert = db.prepare(
			"INSERT OR IGNORE INTO pick (run_id, rank, tmdb_id, title, reason) VALUES (?, ?, ?, ?, ?)",
		);
		picks.forEach((p, i) => {
			const c = byId.get(Number(p.id));
			if (c)
				insert.run(
					lastInsertRowid,
					i + 1,
					c.item.id,
					c.item.name,
					p.reason.trim(),
				);
		});
		db.exec("COMMIT");
		log.info("PICKS_DONE", {
			kind,
			runId: Number(lastInsertRowid),
			candidates: pool.length,
			picks: picks.length,
			model: result.model,
			costUsd: result.costUsd,
		});
		return {
			runId: Number(lastInsertRowid),
			candidates: pool.length,
			costUsd: result.costUsd,
		};
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

export interface Pick {
	kind: MediaKind;
	runId: number;
	rank: number;
	tmdbId: number;
	title: string;
	reason: string;
	feedback: number | null;
	year: string | null;
	poster: string | null;
	genres: string[];
	providers: string[];
	providersLink: string | null;
	onMyServices: boolean;
	/** On one of the user's drives. */
	local: boolean;
	/** TV: seasons and status. Films: runtime and director. */
	detail: string | null;
	tmdbUrl: string;
}

export function latestPicks(kind: MediaKind = "tv"): {
	kind: MediaKind;
	createdAt: string | null;
	model: string | null;
	picks: Pick[];
} {
	const db = getDb();
	const run = db
		.prepare(
			"SELECT id, created_at, model FROM pick_run WHERE kind = ? ORDER BY id DESC LIMIT 1",
		)
		.get(kind) as { id: number; created_at: string; model: string } | undefined;
	if (!run) return { kind, createdAt: null, model: null, picks: [] };
	const rows = db
		.prepare(
			"SELECT run_id, rank, tmdb_id, title, reason, feedback FROM pick WHERE run_id = ? ORDER BY rank",
		)
		.all(run.id) as {
		run_id: number;
		rank: number;
		tmdb_id: number;
		title: string;
		reason: string;
		feedback: number | null;
	}[];
	const table = kind === "tv" ? "tmdb_show" : "tmdb_movie";
	const local = new Set(
		kind === "tv" ? localShows().keys() : localMovies().keys(),
	);
	const cached = db.prepare(`SELECT details FROM ${table} WHERE tmdb_id = ?`);
	return {
		kind,
		createdAt: run.created_at,
		model: run.model,
		picks: rows.map((r) => {
			const row = cached.get(r.tmdb_id) as { details: string } | undefined;
			const base = {
				kind,
				runId: r.run_id,
				rank: r.rank,
				tmdbId: r.tmdb_id,
				title: r.title,
				reason: r.reason,
				feedback: r.feedback,
				local: local.has(r.tmdb_id),
				tmdbUrl: `https://www.themoviedb.org/${kind}/${r.tmdb_id}`,
			};
			if (kind === "tv") {
				const d = row ? (JSON.parse(row.details) as TmdbShow) : null;
				return {
					...base,
					year: d?.firstAirDate?.slice(0, 4) ?? null,
					poster: posterUrl(d?.poster ?? null, "w500"),
					genres: d?.genres ?? [],
					providers: d?.providers ?? [],
					providersLink: d?.providersLink ?? null,
					onMyServices: d ? onMyServices(d.providers) : false,
					detail: d
						? [
								`${d.seasons} season${d.seasons === 1 ? "" : "s"}`,
								d.status,
							].join(" · ")
						: null,
				};
			}
			const d = row ? (JSON.parse(row.details) as TmdbMovie) : null;
			return {
				...base,
				year: d?.releaseDate?.slice(0, 4) ?? null,
				poster: posterUrl(d?.poster ?? null, "w500"),
				genres: d?.genres ?? [],
				providers: d?.providers ?? [],
				providersLink: d?.providersLink ?? null,
				onMyServices: d ? onMyServices(d.providers) : false,
				detail: d
					? [
							d.runtime ? `${d.runtime} min` : null,
							d.directors.length ? `dir. ${d.directors.join(", ")}` : null,
						]
							.filter(Boolean)
							.join(" · ")
					: null,
			};
		}),
	};
}

export function setFeedback(
	runId: number,
	tmdbId: number,
	feedback: 1 | -1 | null,
): void {
	getDb()
		.prepare(
			"UPDATE pick SET feedback = ?, feedback_at = ? WHERE run_id = ? AND tmdb_id = ?",
		)
		.run(
			feedback,
			feedback === null ? null : new Date().toISOString(),
			runId,
			tmdbId,
		);
}
