/**
 * Films, from Letterboxd. There is no API, so two sources combine:
 *
 *   - The CSV export (Settings > Import & Export, unzipped into
 *     COUCH_LETTERBOXD_DIR): full history, ratings, reviews, likes and the
 *     watchlist. Re-imported whenever the files change.
 *   - The public diary RSS feed (letterboxd.com/<user>/rss/): the last ~50
 *     diary entries, with ratings and TMDB ids. Keeps history current between
 *     exports. It has no watchlist, so the watchlist is as fresh as the export.
 *
 * Rows are keyed by normalised "title|year", the only thing both share.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { getDb, getSetting, setSetting } from "./db/index.ts";
import { readCsv } from "./letterboxd.ts";
import { createLogger } from "./log.ts";
import { onMyServices, posterUrl } from "./tmdb.ts";
import { cachedMovie, findMovieId, getMovies } from "./tmdbMovies.ts";

const log = createLogger("films");

const CSV_FILES = [
	"watched.csv",
	"diary.csv",
	"ratings.csv",
	"reviews.csv",
	"likes/films.csv",
	"watchlist.csv",
];

export function filmKey(name: string, year: number | null): string {
	const n = name
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/&/g, "and")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
	return `${n}|${year ?? ""}`;
}

type Fields = Partial<{
	tmdb_id: number | null;
	letterboxd_uri: string;
	rating: number | null;
	liked: number;
	watched: number;
	watched_at: string;
	rewatches: number;
	watchlist: number;
	watchlist_at: string;
	review: string;
}>;

/** Insert or merge one film. watched_at only ever moves forward. */
function upsert(name: string, year: number | null, fields: Fields): void {
	const cols = Object.keys(fields) as (keyof Fields)[];
	const now = new Date().toISOString();
	const set = cols.map((c) =>
		c === "watched_at"
			? "watched_at = MAX(COALESCE(film.watched_at, ''), excluded.watched_at)"
			: `${c} = excluded.${c}`,
	);
	getDb()
		.prepare(
			`INSERT INTO film (key, name, year, updated_at${cols.map((c) => `, ${c}`).join("")})
			 VALUES (?, ?, ?, ?${cols.map(() => ", ?").join("")})
			 ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at${set.map((s) => `, ${s}`).join("")}`,
		)
		.run(
			filmKey(name, year),
			name,
			year,
			now,
			...cols.map((c) => fields[c] ?? null),
		);
}

const year = (r: Record<string, string>) => (r.Year ? Number(r.Year) : null);

// ---------------------------------------------------------------- CSV import

function csvSignature(): string {
	return CSV_FILES.map((f) => {
		const p = join(config.letterboxdDir, f);
		if (!existsSync(p)) return `${f}:-`;
		const st = statSync(p);
		return `${f}:${st.size}:${st.mtimeMs}`;
	}).join(";");
}

/** Import the Letterboxd export. Skips when the files have not changed. */
export function importLetterboxdCsv(force = false): {
	imported: boolean;
	films: number;
} {
	const sig = csvSignature();
	if (!force && getSetting<string>("letterboxd.csv_sig") === sig) {
		return { imported: false, films: filmCount() };
	}
	const watched = readCsv("watched.csv");
	if (watched.length === 0 && readCsv("ratings.csv").length === 0) {
		return { imported: false, films: filmCount() };
	}

	const db = getDb();
	db.exec("BEGIN");
	try {
		for (const r of watched) {
			upsert(r.Name, year(r), {
				watched: 1,
				letterboxd_uri: r["Letterboxd URI"],
			});
		}

		// Diary: latest watch date and rewatch count per film.
		const diary = new Map<
			string,
			{ r: Record<string, string>; at: string; rewatches: number }
		>();
		for (const r of readCsv("diary.csv")) {
			const k = filmKey(r.Name, year(r));
			const at = r["Watched Date"] || r.Date;
			const cur = diary.get(k) ?? { r, at: "", rewatches: 0 };
			if (at > cur.at) cur.at = at;
			if (r.Rewatch === "Yes") cur.rewatches++;
			diary.set(k, cur);
		}
		for (const { r, at, rewatches } of diary.values()) {
			upsert(r.Name, year(r), { watched: 1, watched_at: at, rewatches });
		}

		for (const r of readCsv("ratings.csv")) {
			const rating = Number(r.Rating);
			if (rating > 0) upsert(r.Name, year(r), { rating });
		}
		for (const r of readCsv("reviews.csv")) {
			const review = (r.Review ?? "").trim();
			if (review) upsert(r.Name, year(r), { review });
		}
		for (const r of readCsv("likes/films.csv")) {
			upsert(r.Name, year(r), { liked: 1 });
		}

		// The export is a full snapshot of the watchlist: anything not in it
		// has been watched or removed since.
		const watchlist = readCsv("watchlist.csv");
		if (watchlist.length > 0) {
			db.exec("UPDATE film SET watchlist = 0");
			for (const r of watchlist) {
				upsert(r.Name, year(r), {
					watchlist: 1,
					watchlist_at: r.Date,
					letterboxd_uri: r["Letterboxd URI"],
				});
			}
		}
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
	setSetting("letterboxd.csv_sig", sig);
	const films = filmCount();
	log.info("LETTERBOXD_CSV_IMPORTED", { films });
	return { imported: true, films };
}

// --------------------------------------------------------------------- RSS

export interface RssEntry {
	title: string;
	year: number | null;
	tmdbId: number | null;
	rating: number | null;
	liked: boolean;
	rewatch: boolean;
	watchedDate: string | null;
	review: string | null;
	link: string | null;
}

function decode(s: string): string {
	return s
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) =>
			String.fromCodePoint(Number.parseInt(n, 16)),
		)
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

/** Parse Letterboxd's diary feed. List entries (no film title) are skipped. */
export function parseDiaryRss(xml: string): RssEntry[] {
	const out: RssEntry[] = [];
	for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
		const tag = (name: string) => {
			// Tags may carry attributes (e.g. <guid isPermaLink="false">).
			const m = item.match(
				new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`),
			);
			return m ? decode(m[1]).trim() : null;
		};
		const title = tag("letterboxd:filmTitle");
		if (!title) continue;
		let review: string | null = null;
		if ((tag("guid") ?? "").startsWith("letterboxd-review-")) {
			const html =
				item.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? "";
			const paragraphs = [...decode(html).matchAll(/<p>([\s\S]*?)<\/p>/g)]
				.map((m) => decode(m[1].replace(/<[^>]+>/g, "")).trim())
				.filter((p) => p && !/^Watched on /.test(p));
			review = paragraphs.join("\n\n") || null;
		}
		const yearText = tag("letterboxd:filmYear");
		const ratingText = tag("letterboxd:memberRating");
		const tmdbText = tag("tmdb:movieId");
		out.push({
			title,
			year: yearText ? Number(yearText) : null,
			tmdbId: tmdbText ? Number(tmdbText) : null,
			rating: ratingText ? Number(ratingText) : null,
			liked: tag("letterboxd:memberLike") === "Yes",
			rewatch: tag("letterboxd:rewatch") === "Yes",
			watchedDate: tag("letterboxd:watchedDate"),
			review,
			link: tag("link"),
		});
	}
	return out;
}

export async function syncLetterboxdRss(): Promise<{ entries: number }> {
	const user = config.letterboxdUsername;
	if (!user) return { entries: 0 };
	const res = await fetch(
		`https://letterboxd.com/${encodeURIComponent(user)}/rss/`,
		{
			headers: { "User-Agent": "couch/1.0" },
			signal: AbortSignal.timeout(15_000),
		},
	);
	if (!res.ok) throw new Error(`Letterboxd RSS returned ${res.status}`);
	const entries = parseDiaryRss(await res.text());
	const db = getDb();
	db.exec("BEGIN");
	try {
		for (const e of entries) {
			const fields: Fields = { watched: 1, watchlist: 0 };
			if (e.watchedDate) fields.watched_at = e.watchedDate;
			if (e.tmdbId) fields.tmdb_id = e.tmdbId;
			if (e.rating) fields.rating = e.rating;
			if (e.liked) fields.liked = 1;
			if (e.review) fields.review = e.review;
			upsert(e.title, e.year, fields);
		}
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
	setSetting("letterboxd.rss_synced_at", new Date().toISOString());
	return { entries: entries.length };
}

// ------------------------------------------------------------ TMDB matching

/** Give CSV-imported films a TMDB id. Misses are retried after 30 days. */
export async function resolveTmdbIds(
	limit = 600,
): Promise<{ matched: number; missed: number }> {
	const db = getDb();
	const retryBefore = new Date(Date.now() - 30 * 86_400_000).toISOString();
	const rows = db
		.prepare(
			`SELECT key, name, year FROM film
			 WHERE tmdb_id IS NULL AND (tmdb_lookup_at IS NULL OR tmdb_lookup_at < ?)
			 ORDER BY watchlist DESC, rating DESC NULLS LAST LIMIT ?`,
		)
		.all(retryBefore, limit) as {
		key: string;
		name: string;
		year: number | null;
	}[];
	const update = db.prepare(
		"UPDATE film SET tmdb_id = ?, tmdb_lookup_at = ? WHERE key = ?",
	);
	let matched = 0;
	let missed = 0;
	const queue = [...rows];
	await Promise.all(
		Array.from({ length: 6 }, async () => {
			for (let r = queue.shift(); r; r = queue.shift()) {
				try {
					const id = await findMovieId(r.name, r.year);
					update.run(id, new Date().toISOString(), r.key);
					if (id) matched++;
					else missed++;
				} catch (error) {
					log.warn("TMDB_MATCH_FAILED", { film: r.name, year: r.year }, error);
				}
			}
		}),
	);
	if (rows.length) log.info("TMDB_MATCHED", { matched, missed });
	return { matched, missed };
}

/** Refresh details (and so providers) for watchlist films. */
export async function refreshWatchlistDetails(): Promise<number> {
	const rows = getDb()
		.prepare(
			"SELECT tmdb_id FROM film WHERE watchlist = 1 AND tmdb_id IS NOT NULL",
		)
		.all() as { tmdb_id: number }[];
	return (await getMovies(rows.map((r) => r.tmdb_id))).size;
}

// ----------------------------------------------------------------- queries

export function filmCount(): number {
	return (
		getDb().prepare("SELECT COUNT(*) AS n FROM film").get() as { n: number }
	).n;
}

export function filmStats() {
	return {
		...(getDb()
			.prepare(
				`SELECT SUM(watched) AS watched, SUM(watchlist) AS watchlist,
			        SUM(rating IS NOT NULL) AS rated, SUM(tmdb_id IS NULL) AS unmatched
			 FROM film`,
			)
			.get() as {
			watched: number;
			watchlist: number;
			rated: number;
			unmatched: number;
		}),
	};
}

export function watchedFilmTmdbIds(): Set<number> {
	const rows = getDb()
		.prepare(
			"SELECT tmdb_id FROM film WHERE watched = 1 AND tmdb_id IS NOT NULL",
		)
		.all() as { tmdb_id: number }[];
	return new Set(rows.map((r) => r.tmdb_id));
}

export function watchlistTmdbIds(): number[] {
	return (
		getDb()
			.prepare(
				"SELECT tmdb_id FROM film WHERE watchlist = 1 AND watched = 0 AND tmdb_id IS NOT NULL",
			)
			.all() as { tmdb_id: number }[]
	).map((r) => r.tmdb_id);
}

export function filmSeeds(limit = 15): { tmdbId: number; title: string }[] {
	return getDb()
		.prepare(
			`SELECT tmdb_id AS tmdbId, name AS title FROM film
			 WHERE watched = 1 AND tmdb_id IS NOT NULL AND (rating >= 4.5 OR (liked = 1 AND rating >= 4))
			 ORDER BY rating DESC, watched_at DESC NULLS LAST LIMIT ?`,
		)
		.all(limit) as { tmdbId: number; title: string }[];
}

export interface StreamingFilm {
	tmdbId: number;
	title: string;
	year: number | null;
	poster: string | null;
	providers: string[];
	runtime: number | null;
	url: string;
}

/** Watchlist films currently streaming on the user's services. */
export function watchlistStreaming(): StreamingFilm[] {
	const rows = getDb()
		.prepare(
			`SELECT name, year, tmdb_id, letterboxd_uri FROM film
			 WHERE watchlist = 1 AND watched = 0 AND tmdb_id IS NOT NULL
			 ORDER BY watchlist_at DESC`,
		)
		.all() as {
		name: string;
		year: number | null;
		tmdb_id: number;
		letterboxd_uri: string | null;
	}[];
	const out: StreamingFilm[] = [];
	for (const r of rows) {
		const m = cachedMovie(r.tmdb_id);
		if (!m || !onMyServices(m.providers)) continue;
		out.push({
			tmdbId: r.tmdb_id,
			title: r.name,
			year: r.year,
			poster: posterUrl(m.poster),
			providers: m.providers,
			runtime: m.runtime,
			url: r.letterboxd_uri ?? `https://www.themoviedb.org/movie/${r.tmdb_id}`,
		});
	}
	return out;
}
