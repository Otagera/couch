import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

// config reads the environment at import time, so set it before importing.
const work = mkdtempSync(join(tmpdir(), "couch-"));
process.env.COUCH_DB_PATH = join(work, "couch.db");
process.env.COUCH_LETTERBOXD_DIR = work;
process.env.STREAMING_SERVICES = "Netflix, Prime Video";
process.env.COUCH_STALLED_DAYS = "42";

const { getDb, closeDb, getSetting, setSetting } = await import(
	"../src/server/db/index.ts"
);
const { parseCsv, filmRatings, filmReviews } = await import(
	"../src/server/letterboxd.ts"
);
const { replaceShows } = await import("../src/server/simkl.ts");
const { upNext, listShows, libraryStats } = await import(
	"../src/server/library.ts"
);
const { parseJson } = await import("../src/server/llm.ts");
const { preRank } = await import("../src/server/picks.ts");
const { onMyServices } = await import("../src/server/tmdb.ts");
const { historyText, setNotes } = await import("../src/server/taste.ts");

after(() => {
	closeDb();
	rmSync(work, { recursive: true, force: true });
});

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-17T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

function raw(
	id: number,
	title: string,
	status: string,
	extra: Partial<{
		rating: number;
		watched: number;
		total: number;
		lastWatchedAt: string;
		tmdb: string;
	}> = {},
) {
	return {
		status,
		user_rating: extra.rating ?? null,
		user_rated_at: null,
		added_to_watchlist_at: null,
		last_watched_at: extra.lastWatchedAt ?? null,
		last_watched: null,
		next_to_watch: null,
		watched_episodes_count: extra.watched ?? 0,
		total_episodes_count: extra.total ?? 0,
		not_aired_episodes_count: 0,
		show: {
			title,
			year: 2020,
			ids: { simkl: id, slug: title.toLowerCase(), tmdb: extra.tmdb },
		},
		// biome-ignore lint/suspicious/noExplicitAny: test fixture mirrors the raw API shape
	} as any;
}

beforeEach(() => {
	getDb().exec(
		"DELETE FROM show; DELETE FROM pick; DELETE FROM pick_run; DELETE FROM setting;",
	);
});

test("parseCsv handles quotes, escaped quotes and newlines in fields", () => {
	const rows = parseCsv(
		'Name,Review\r\n"Heat","Great, ""tense""\nfilm"\nAlien,ok\n',
	);
	assert.deepEqual(rows, [
		{ Name: "Heat", Review: 'Great, "tense"\nfilm' },
		{ Name: "Alien", Review: "ok" },
	]);
});

test("Letterboxd files are read when present and skipped when missing", () => {
	assert.equal(filmRatings().length, 0);
	writeFileSync(
		join(work, "ratings.csv"),
		"Date,Name,Year,Letterboxd URI,Rating\n2024-01-01,Heat,1995,x,5\n",
	);
	writeFileSync(
		join(work, "reviews.csv"),
		"Date,Name,Year,Letterboxd URI,Rating,Rewatch,Review,Tags,Watched Date\n2024-01-01,Heat,1995,x,5,,Perfect.,,2023-12-30\n2024-01-02,Alien,1979,y,4,,,,\n",
	);
	assert.deepEqual(filmRatings(), [
		{ name: "Heat", year: 1995, rating: 5, date: "2024-01-01" },
	]);
	const reviews = filmReviews();
	assert.equal(reviews.length, 1, "reviews without text are dropped");
	assert.equal(
		reviews[0].date,
		"2023-12-30",
		"watched date wins over log date",
	);
});

test("replaceShows mirrors the library, including removals", () => {
	replaceShows([raw(1, "Severance", "watching"), raw(2, "Dark", "completed")]);
	assert.equal(listShows().length, 2);
	replaceShows([raw(1, "Severance", "completed")]);
	assert.deepEqual(
		listShows().map((s) => [s.title, s.status]),
		[["Severance", "completed"]],
	);
	assert.deepEqual(libraryStats(), { completed: 1 });
});

test("upNext separates active, stalled and new-episode shows", () => {
	replaceShows([
		raw(1, "Active", "watching", {
			watched: 3,
			total: 10,
			lastWatchedAt: ago(2),
		}),
		raw(2, "Older active", "watching", {
			watched: 1,
			total: 8,
			lastWatchedAt: ago(20),
		}),
		raw(3, "Stalled", "watching", {
			watched: 4,
			total: 9,
			lastWatchedAt: ago(90),
		}),
		raw(4, "Caught up", "watching", {
			watched: 5,
			total: 5,
			lastWatchedAt: ago(1),
		}),
		raw(5, "New season", "completed", {
			watched: 10,
			total: 18,
			lastWatchedAt: ago(300),
		}),
		raw(6, "Done", "completed", { watched: 6, total: 6 }),
		raw(7, "Dropped", "dropped", {
			watched: 2,
			total: 10,
			lastWatchedAt: ago(5),
		}),
	]);
	const u = upNext(NOW);
	assert.deepEqual(
		u.continueWatching.map((s) => s.title),
		["Active", "Older active"],
	);
	assert.deepEqual(
		u.stalled.map((s) => s.title),
		["Stalled"],
	);
	assert.deepEqual(
		u.newEpisodes.map((s) => s.title),
		["New season"],
	);
});

test("history text includes viewer notes, statuses and progress on dropped shows", () => {
	replaceShows([
		raw(1, "Severance", "completed", { rating: 9 }),
		raw(2, "Lost", "dropped", { watched: 12, total: 121 }),
	]);
	setNotes("No more true crime, please.");
	const text = historyText();
	assert.match(text, /Notes from the viewer[\s\S]*No more true crime/);
	assert.match(text, /Severance \(2020\) 9\/10/);
	assert.match(text, /Lost \(2020\) \(stopped at 12\/121 eps\)/);
});

test("settings round-trip as JSON", () => {
	setSetting("x", { a: 1 });
	assert.deepEqual(getSetting("x"), { a: 1 });
	assert.equal(getSetting("missing"), null);
});

test("parseJson tolerates code fences and surrounding prose", () => {
	assert.deepEqual(parseJson('Sure!\n```json\n{"picks":[{"id":1}]}\n```'), {
		picks: [{ id: 1 }],
	});
	assert.throws(() => parseJson("no json here"));
});

test("onMyServices matches provider names case-insensitively", () => {
	assert.equal(onMyServices(["NETFLIX"]), true);
	assert.equal(onMyServices(["Hulu"]), false);
});

test("preRank favours shows several favourites point to", () => {
	const item = (id: number, voteAverage = 7) => ({
		id,
		name: `Show ${id}`,
		overview: "",
		firstAirDate: null,
		genreIds: [],
		voteAverage,
		voteCount: 500,
		poster: null,
		originalLanguage: "en",
	});
	const ranked = preRank([
		{ item: item(1, 9), because: new Set(), sources: new Set(["trending"]) },
		{
			item: item(2, 7),
			because: new Set(["A", "B", "C"]),
			sources: new Set(["similar"]),
		},
	]);
	assert.deepEqual(
		ranked.map((c) => c.item.id),
		[2, 1],
	);
});
