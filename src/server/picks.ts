/**
 * Picks: what to watch next.
 *
 *   1. Candidates, no LLM: TMDB "recommendations" for the user's best-rated
 *      shows, well-rated shows on their services, and this week's trending.
 *      Anything already in the Simkl library or rejected before is dropped.
 *   2. A cheap pre-rank (how many favourites point at it, plus TMDB score)
 *      trims the pool to ~60, which get full details and providers.
 *   3. One call to a strong model with the taste profile chooses the picks
 *      and explains each in terms of the user's own history.
 */

import { config } from "./config.ts";
import { getDb } from "./db/index.ts";
import { libraryTmdbIds } from "./library.ts";
import { chat, parseJson } from "./llm.ts";
import { createLogger } from "./log.ts";
import { buildProfile } from "./taste.ts";
import {
	discoverOnMyServices,
	getShows,
	onMyServices,
	posterUrl,
	recommendationsFor,
	type TmdbListItem,
	type TmdbShow,
	trending,
} from "./tmdb.ts";

const log = createLogger("picks");

const POOL_SIZE = 60;
const PICK_COUNT = 8;
const MAX_SEEDS = 15;

interface Candidate {
	item: TmdbListItem;
	/** Library shows whose TMDB recommendations included this one. */
	because: Set<string>;
	sources: Set<string>;
}

function seeds(): { tmdbId: number; title: string }[] {
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

function rejectedIds(): Set<number> {
	const rows = getDb()
		.prepare("SELECT DISTINCT tmdb_id FROM pick WHERE feedback < 0")
		.all() as {
		tmdb_id: number;
	}[];
	return new Set(rows.map((r) => r.tmdb_id));
}

export async function gatherCandidates(): Promise<Candidate[]> {
	const exclude = new Set([...libraryTmdbIds(), ...rejectedIds()]);
	const pool = new Map<number, Candidate>();
	const add = (item: TmdbListItem, source: string, because?: string) => {
		if (exclude.has(item.id)) return;
		const c = pool.get(item.id) ?? {
			item,
			because: new Set(),
			sources: new Set(),
		};
		c.sources.add(source);
		if (because) c.because.add(because);
		pool.set(item.id, c);
	};

	const settled = await Promise.allSettled([
		...seeds().map(async (s) => {
			for (const item of await recommendationsFor(s.tmdbId))
				add(item, "similar", s.title);
		}),
		discoverOnMyServices(1).then((items) => {
			for (const i of items) add(i, "my-services");
		}),
		discoverOnMyServices(2).then((items) => {
			for (const i of items) add(i, "my-services");
		}),
		trending().then((items) => {
			for (const i of items) add(i, "trending");
		}),
	]);
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
		(c.item.voteCount >= 100 ? c.item.voteAverage / 5 : 0);
	return [...candidates]
		.sort((a, b) => score(b) - score(a))
		.slice(0, POOL_SIZE);
}

function describe(c: Candidate, d: TmdbShow | undefined): string {
	const year = (d?.firstAirDate ?? c.item.firstAirDate)?.slice(0, 4) ?? "?";
	const parts = [
		`[${c.item.id}] ${c.item.name} (${year})`,
		d?.genres.length ? d.genres.join("/") : null,
		d?.networks[0] ?? null,
		d ? `${d.seasons} season${d.seasons === 1 ? "" : "s"}, ${d.status}` : null,
		d?.episodeRuntime ? `${d.episodeRuntime}min eps` : null,
		`TMDB ${c.item.voteAverage.toFixed(1)} (${c.item.voteCount} votes)`,
		d && onMyServices(d.providers)
			? `ON THEIR SERVICES: ${d.providers.join(", ")}`
			: d?.providers.length
				? `streams on ${d.providers.join(", ")}`
				: "no streaming in their country",
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

const SYSTEM = `You choose TV shows for one specific viewer.
You get their taste profile and a numbered list of candidate shows they have not watched.
Choose exactly ${PICK_COUNT} shows from the list. Only choose ids that appear in the list.

Prefer shows on their streaming services, but up to 2 picks may be elsewhere if they are an
unusually strong match. Mix safe bets with one or two less obvious choices. Avoid near-duplicates.

For each pick write one or two sentences, addressed to the viewer, saying why it suits them,
grounded in their actual history (name shows or films they liked). No plot summaries, no hype.

Reply with JSON only: {"picks":[{"id":123,"reason":"..."}]} ordered best first.`;

export interface PickRun {
	runId: number;
	candidates: number;
	costUsd: number | null;
}

export async function runPicks(): Promise<PickRun> {
	const { profile } = await buildProfile();
	const pool = preRank(await gatherCandidates());
	if (pool.length === 0)
		throw new Error("No candidates found. Sync your Simkl library first.");
	const details = await getShows(pool.map((c) => c.item.id));

	const result = await chat(
		config.pickModel,
		[
			{ role: "system", content: SYSTEM },
			{
				role: "user",
				content: `# Taste profile\n${profile.text}\n\n# Their streaming services\n${
					config.services.join(", ") || "not set"
				} (country ${config.countryCode})\n\n# Candidates\n${pool
					.map((c) => describe(c, details.get(c.item.id)))
					.join("\n")}`,
			},
		],
		{ json: true, maxTokens: 2500 },
	);

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
				"INSERT INTO pick_run (created_at, model, candidates, note) VALUES (?, ?, ?, ?)",
			)
			.run(
				new Date().toISOString(),
				result.model,
				pool.length,
				JSON.stringify({
					costUsd: result.costUsd,
					profileCostUsd: profile.costUsd,
				}),
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
	seasons: number | null;
	status: string | null;
}

export function latestPicks(): {
	createdAt: string | null;
	model: string | null;
	picks: Pick[];
} {
	const db = getDb();
	const run = db
		.prepare(
			"SELECT id, created_at, model FROM pick_run ORDER BY id DESC LIMIT 1",
		)
		.get() as { id: number; created_at: string; model: string } | undefined;
	if (!run) return { createdAt: null, model: null, picks: [] };
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
	const cached = db.prepare("SELECT details FROM tmdb_show WHERE tmdb_id = ?");
	return {
		createdAt: run.created_at,
		model: run.model,
		picks: rows.map((r) => {
			const row = cached.get(r.tmdb_id) as { details: string } | undefined;
			const d = row ? (JSON.parse(row.details) as TmdbShow) : null;
			return {
				runId: r.run_id,
				rank: r.rank,
				tmdbId: r.tmdb_id,
				title: r.title,
				reason: r.reason,
				feedback: r.feedback,
				year: d?.firstAirDate?.slice(0, 4) ?? null,
				poster: posterUrl(d?.poster ?? null, "w500"),
				genres: d?.genres ?? [],
				providers: d?.providers ?? [],
				providersLink: d?.providersLink ?? null,
				onMyServices: d ? onMyServices(d.providers) : false,
				seasons: d?.seasons ?? null,
				status: d?.status ?? null,
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
