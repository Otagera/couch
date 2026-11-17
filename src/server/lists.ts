/**
 * Letterboxd lists the user follows, for working through a series in order
 * ("MCU chronological: next is Ant-Man and the Wasp, 12/33").
 *
 * Where lists come from:
 *   - own:   the user's lists in the export (data/lists/*.csv header URL)
 *   - liked: likes/lists.csv in the export (Letterboxd's "follow" is a like)
 *   - added: a list URL pasted into Couch
 *
 * Letterboxd has no API, so a list is read from its public page (100 films
 * per page). That is scraping: it can break if Letterboxd changes its markup,
 * so it is done sparingly -- each list at most once a day, pages one at a
 * time with a pause -- and a failure only marks that list, never the sync.
 *
 * Items are matched to TMDB without extra Letterboxd requests: first against
 * films already matched from the user's history, then by TMDB search.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { getDb } from "./db/index.ts";
import { filmKey } from "./films.ts";
import { parseCsv } from "./letterboxd.ts";
import { createLogger } from "./log.ts";
import { findMovieId } from "./tmdbMovies.ts";

const log = createLogger("lists");

const REFRESH_MS = 86_400_000;
const PAGE_PAUSE_MS = 1200;
const MAX_PAGES = 20;
const UA = { "User-Agent": "couch/1.0 (personal watch tracker)" };
const LIST_URL = /^https:\/\/letterboxd\.com\/([^/]+)\/list\/([^/]+)\/$/;

export class ListError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Turn any list link (boxd.it short link, page/N, missing slash) into its canonical URL. */
export async function canonicalListUrl(input: string): Promise<string> {
	let url = input.trim();
	if (!/^https?:\/\//.test(url)) url = `https://${url}`;
	if (/^https?:\/\/boxd\.it\//.test(url)) {
		const res = await fetch(url, {
			headers: UA,
			redirect: "follow",
			signal: AbortSignal.timeout(15_000),
		});
		url = res.url;
	}
	const m = url
		.replace(/^http:/, "https:")
		.replace(/^https:\/\/www\./, "https://")
		.match(/^https:\/\/letterboxd\.com\/([^/]+)\/list\/([^/?#]+)/);
	if (!m)
		throw new ListError(
			"That doesn't look like a Letterboxd list link (letterboxd.com/<user>/list/<name>/).",
		);
	return `https://letterboxd.com/${m[1]}/list/${m[2]}/`;
}

// ------------------------------------------------------------------ parsing

export interface ParsedPage {
	name: string | null;
	items: { index: number; slug: string; name: string; year: number | null }[];
	lastPage: number;
}

const attr = (html: string, name: string) => {
	const m = html.match(new RegExp(`${name}="([^"]*)"`));
	return m ? decodeHtml(m[1]) : null;
};

function decodeHtml(s: string): string {
	return s
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) =>
			String.fromCodePoint(Number.parseInt(n, 16)),
		)
		.replace(/&quot;/g, '"')
		.replace(/&#039;|&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&lrm;|&rlm;/g, "")
		.replace(/&amp;/g, "&");
}

/** Parse one list page. Positions come from data-list-index, which runs across pages. */
export function parseListPage(html: string): ParsedPage {
	const items: ParsedPage["items"] = [];
	// Plain lists use class="posteritem"; ranked ones add "numbered-list-item".
	for (const chunk of html.split(/<li class="posteritem[^"]*"/).slice(1)) {
		const slug = attr(chunk, "data-item-slug");
		const display =
			attr(chunk, "data-item-full-display-name") ??
			attr(chunk, "data-item-name");
		const index = Number(attr(chunk, "data-list-index"));
		if (!slug || !display || !Number.isFinite(index)) continue;
		const m = display.match(/^(.*) \((\d{4})\)$/);
		items.push({
			index,
			slug,
			name: m ? m[1] : display,
			year: m ? Number(m[2]) : null,
		});
	}
	const ogTitle = html.match(/<meta property="og:title" content="([^"]*)"/);
	const pages = [...html.matchAll(/\/page\/(\d+)\/"/g)].map((m) =>
		Number(m[1]),
	);
	return {
		name: ogTitle ? decodeHtml(ogTitle[1]).trim() : null,
		items,
		lastPage: Math.max(1, ...pages),
	};
}

async function fetchPage(url: string): Promise<string> {
	const res = await fetch(url, {
		headers: UA,
		signal: AbortSignal.timeout(20_000),
	});
	if (res.status === 404)
		throw new ListError("List not found (deleted, renamed or private).");
	if (!res.ok)
		throw new ListError(`Letterboxd returned ${res.status} for this list.`);
	return res.text();
}

// ------------------------------------------------------------- following

export function followList(
	url: string,
	origin: "own" | "liked" | "added",
): number {
	const db = getDb();
	db.prepare(
		`INSERT INTO list (url, origin, created_at) VALUES (?, ?, ?)
		 ON CONFLICT(url) DO UPDATE SET hidden = 0`,
	).run(url, origin, new Date().toISOString());
	return (
		db.prepare("SELECT id FROM list WHERE url = ?").get(url) as { id: number }
	).id;
}

export function unfollowList(id: number): void {
	// Hidden rather than deleted, so a re-import of the export doesn't bring it back.
	getDb().prepare("UPDATE list SET hidden = 1 WHERE id = ?").run(id);
}

/** Add the user's own and liked lists from the export, by their short links. */
export async function importExportedLists(): Promise<number> {
	const urls: { url: string; origin: "own" | "liked" }[] = [];
	const liked = join(config.letterboxdDir, "likes", "lists.csv");
	if (existsSync(liked)) {
		for (const r of parseCsv(readFileSync(liked, "utf8"))) {
			if (r.Content) urls.push({ url: r.Content, origin: "liked" });
		}
	}
	const ownDir = join(config.letterboxdDir, "lists");
	if (existsSync(ownDir)) {
		for (const f of readdirSync(ownDir).filter((f) => f.endsWith(".csv"))) {
			// Own list files start with a version line, then a one-row header block.
			const text = readFileSync(join(ownDir, f), "utf8")
				.split("\n")
				.slice(1)
				.join("\n");
			const url = parseCsv(text)[0]?.URL;
			if (url) urls.push({ url, origin: "own" });
		}
	}
	const db = getDb();
	const known = db.prepare("SELECT 1 FROM list WHERE url = ?");
	const seen = db.prepare("SELECT value FROM setting WHERE key = ?");
	let added = 0;
	for (const { url, origin } of urls) {
		// Short links are resolved once and remembered, so each sync doesn't hit boxd.it.
		const memo = `lists.short.${url}`;
		const cached = seen.get(memo) as { value: string } | undefined;
		let canonical = cached ? (JSON.parse(cached.value) as string) : null;
		if (!canonical) {
			try {
				canonical = await canonicalListUrl(url);
				db.prepare(
					"INSERT OR REPLACE INTO setting (key, value, updated_at) VALUES (?, ?, ?)",
				).run(memo, JSON.stringify(canonical), new Date().toISOString());
				await sleep(PAGE_PAUSE_MS);
			} catch (error) {
				log.warn("LIST_SHORTLINK_FAILED", { url }, error);
				continue;
			}
		}
		if (!known.get(canonical)) {
			followList(canonical, origin);
			added++;
		}
	}
	return added;
}

// --------------------------------------------------------------- refresh

/** Re-read one list from Letterboxd and match its films to TMDB. */
export async function refreshList(id: number): Promise<void> {
	const db = getDb();
	const list = db.prepare("SELECT url FROM list WHERE id = ?").get(id) as
		| { url: string }
		| undefined;
	if (!list) throw new ListError("Unknown list.");
	const m = list.url.match(LIST_URL);
	try {
		const first = parseListPage(await fetchPage(list.url));
		const items = [...first.items];
		for (let p = 2; p <= Math.min(first.lastPage, MAX_PAGES); p++) {
			await sleep(PAGE_PAUSE_MS);
			items.push(
				...parseListPage(await fetchPage(`${list.url}page/${p}/`)).items,
			);
		}
		items.sort((a, b) => a.index - b.index);

		const insert = db.prepare(
			"INSERT OR REPLACE INTO list_item (list_id, position, slug, name, year, tmdb_id) VALUES (?, ?, ?, ?, ?, ?)",
		);
		const slugId = db.prepare("SELECT tmdb_id FROM lb_slug WHERE slug = ?");
		const filmId = db.prepare(
			"SELECT tmdb_id FROM film WHERE key = ? AND tmdb_id IS NOT NULL",
		);
		db.exec("BEGIN");
		try {
			db.prepare("DELETE FROM list_item WHERE list_id = ?").run(id);
			items.forEach((it, i) => {
				const known =
					(slugId.get(it.slug) as { tmdb_id: number | null } | undefined)
						?.tmdb_id ??
					(
						filmId.get(filmKey(it.name, it.year)) as
							| { tmdb_id: number }
							| undefined
					)?.tmdb_id ??
					null;
				insert.run(id, i + 1, it.slug, it.name, it.year, known);
			});
			db.prepare(
				"UPDATE list SET name = ?, owner = ?, items = ?, fetched_at = ?, error = NULL WHERE id = ?",
			).run(
				first.name,
				m ? m[1] : null,
				items.length,
				new Date().toISOString(),
				id,
			);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
		await matchListItems(id);
		log.info("LIST_REFRESHED", { id, items: items.length });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		db.prepare("UPDATE list SET error = ?, fetched_at = ? WHERE id = ?").run(
			message,
			new Date().toISOString(),
			id,
		);
		log.warn("LIST_REFRESH_FAILED", { id, url: list.url }, error);
		throw error;
	}
}

/** TMDB ids for list items that are not matched yet, remembered per slug. */
async function matchListItems(id: number): Promise<void> {
	const db = getDb();
	const rows = db
		.prepare(
			`SELECT DISTINCT i.slug, i.name, i.year FROM list_item i
			 LEFT JOIN lb_slug s ON s.slug = i.slug
			 WHERE i.list_id = ? AND i.tmdb_id IS NULL AND s.slug IS NULL`,
		)
		.all(id) as { slug: string; name: string; year: number | null }[];
	const remember = db.prepare(
		"INSERT OR REPLACE INTO lb_slug (slug, tmdb_id, matched_at) VALUES (?, ?, ?)",
	);
	const queue = [...rows];
	await Promise.all(
		Array.from({ length: 6 }, async () => {
			for (let r = queue.shift(); r; r = queue.shift()) {
				try {
					remember.run(
						r.slug,
						await findMovieId(r.name, r.year),
						new Date().toISOString(),
					);
				} catch (error) {
					log.warn("LIST_ITEM_MATCH_FAILED", { slug: r.slug }, error);
				}
			}
		}),
	);
	db.prepare(
		`UPDATE list_item SET tmdb_id = (SELECT tmdb_id FROM lb_slug s WHERE s.slug = list_item.slug)
		 WHERE list_id = ? AND tmdb_id IS NULL`,
	).run(id);
}

/** Refresh every followed list not read in the last day. Failures are per list. */
export async function refreshDueLists(
	force = false,
): Promise<{ refreshed: number; failed: number }> {
	const cutoff = new Date(Date.now() - REFRESH_MS).toISOString();
	const due = getDb()
		.prepare(
			`SELECT id FROM list WHERE hidden = 0 AND (? OR fetched_at IS NULL OR fetched_at < ?) ORDER BY fetched_at NULLS FIRST`,
		)
		.all(force ? 1 : 0, cutoff) as { id: number }[];
	let refreshed = 0;
	let failed = 0;
	for (const { id } of due) {
		try {
			await refreshList(id);
			refreshed++;
		} catch {
			failed++;
		}
		await sleep(PAGE_PAUSE_MS);
	}
	return { refreshed, failed };
}

// --------------------------------------------------------------- progress

export interface ListProgress {
	id: number;
	url: string;
	name: string;
	owner: string | null;
	origin: string;
	total: number;
	watched: number;
	/** First film in list order not yet watched. */
	next: {
		position: number;
		name: string;
		year: number | null;
		tmdbId: number | null;
	} | null;
	/** Most recent watch of any film in the list, for ordering. */
	lastWatchedAt: string | null;
	fetchedAt: string | null;
	error: string | null;
}

export function listProgress(): ListProgress[] {
	const db = getDb();
	const lists = db
		.prepare(
			"SELECT id, url, name, owner, origin, items, fetched_at, error FROM list WHERE hidden = 0",
		)
		.all() as {
		id: number;
		url: string;
		name: string | null;
		owner: string | null;
		origin: string;
		items: number;
		fetched_at: string | null;
		error: string | null;
	}[];
	// Match on TMDB id; MAX() collapses duplicate film rows for one id.
	const itemsOf = db.prepare(
		`SELECT i.position, i.name, i.year, i.tmdb_id,
		        COALESCE(MAX(f.watched), 0) AS watched, MAX(f.watched_at) AS watched_at
		 FROM list_item i
		 LEFT JOIN film f ON f.tmdb_id = i.tmdb_id AND i.tmdb_id IS NOT NULL
		 WHERE i.list_id = ? GROUP BY i.position ORDER BY i.position`,
	);
	const byKey = db.prepare(
		"SELECT watched, watched_at FROM film WHERE key = ?",
	);
	return lists
		.map((l) => {
			const rows = itemsOf.all(l.id) as {
				position: number;
				name: string;
				year: number | null;
				tmdb_id: number | null;
				watched: number;
				watched_at: string | null;
			}[];
			let watched = 0;
			let next: ListProgress["next"] = null;
			let lastWatchedAt: string | null = null;
			for (const r of rows) {
				// Unmatched items fall back to the title|year key.
				const w = r.watched
					? { watched: 1, watched_at: r.watched_at }
					: ((byKey.get(filmKey(r.name, r.year)) as
							| { watched: number; watched_at: string | null }
							| undefined) ?? {
							watched: 0,
							watched_at: null,
						});
				if (w.watched) {
					watched++;
					if (w.watched_at && (!lastWatchedAt || w.watched_at > lastWatchedAt))
						lastWatchedAt = w.watched_at;
				} else if (!next) {
					next = {
						position: r.position,
						name: r.name,
						year: r.year,
						tmdbId: r.tmdb_id,
					};
				}
			}
			return {
				id: l.id,
				url: l.url,
				name:
					l.name ?? l.url.match(LIST_URL)?.[2]?.replace(/-/g, " ") ?? "List",
				owner: l.owner,
				origin: l.origin,
				total: rows.length,
				watched,
				next,
				lastWatchedAt,
				fetchedAt: l.fetched_at,
				error: l.error,
			};
		})
		.sort(
			(a, b) =>
				(b.lastWatchedAt ?? "").localeCompare(a.lastWatchedAt ?? "") ||
				b.watched - a.watched,
		);
}

export interface ListItemView {
	position: number;
	name: string;
	year: number | null;
	tmdbId: number | null;
	slug: string;
	watched: boolean;
}

export function listItems(id: number): ListItemView[] {
	const db = getDb();
	const rows = db
		.prepare(
			"SELECT position, slug, name, year, tmdb_id FROM list_item WHERE list_id = ? ORDER BY position",
		)
		.all(id) as {
		position: number;
		slug: string;
		name: string;
		year: number | null;
		tmdb_id: number | null;
	}[];
	const byId = db.prepare(
		"SELECT watched FROM film WHERE tmdb_id = ? AND watched = 1",
	);
	const byKey = db.prepare(
		"SELECT watched FROM film WHERE key = ? AND watched = 1",
	);
	return rows.map((r) => ({
		position: r.position,
		name: r.name,
		year: r.year,
		tmdbId: r.tmdb_id,
		slug: r.slug,
		watched: Boolean(
			(r.tmdb_id && byId.get(r.tmdb_id)) || byKey.get(filmKey(r.name, r.year)),
		),
	}));
}
