import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const work = mkdtempSync(join(tmpdir(), "couch-films-"));
process.env.COUCH_DB_PATH = join(work, "couch.db");
process.env.COUCH_LETTERBOXD_DIR = work;

const { getDb, closeDb } = await import("../src/server/db/index.ts");
const { filmKey, importLetterboxdCsv, parseDiaryRss, filmStats, filmSeeds } =
	await import("../src/server/films.ts");
const { historyText } = await import("../src/server/taste.ts");

after(() => {
	closeDb();
	rmSync(work, { recursive: true, force: true });
});

const RSS = `<?xml version="1.0"?><rss><channel>
<item> <title>Heat, 1995 - ★★★★½</title> <link>https://letterboxd.com/u/film/heat/</link>
<guid isPermaLink="false">letterboxd-review-1</guid>
<letterboxd:watchedDate>2026-11-14</letterboxd:watchedDate> <letterboxd:rewatch>Yes</letterboxd:rewatch>
<letterboxd:filmTitle>Heat</letterboxd:filmTitle> <letterboxd:filmYear>1995</letterboxd:filmYear>
<letterboxd:memberRating>4.5</letterboxd:memberRating> <letterboxd:memberLike>Yes</letterboxd:memberLike>
<tmdb:movieId>949</tmdb:movieId>
<description><![CDATA[ <p><img src="x.jpg"/></p> <p>It&#039;s &quot;perfect&quot; &amp; tense.</p> ]]></description></item>
<item> <title>Am&eacute;lie</title> <guid isPermaLink="false">letterboxd-watch-2</guid>
<letterboxd:watchedDate>2026-11-10</letterboxd:watchedDate>
<letterboxd:filmTitle>Am&#233;lie</letterboxd:filmTitle> <letterboxd:filmYear>2001</letterboxd:filmYear>
<tmdb:movieId>194</tmdb:movieId>
<description><![CDATA[ <p><img src="y.jpg"/></p> <p>Watched on Tuesday November 10, 2026.</p> ]]></description></item>
<item> <title>A list</title> <guid isPermaLink="false">letterboxd-list-3</guid> <description>list</description></item>
</channel></rss>`;

test("parseDiaryRss reads films, ratings, reviews and skips lists", () => {
	const entries = parseDiaryRss(RSS);
	assert.equal(entries.length, 2);
	assert.deepEqual(entries[0], {
		title: "Heat",
		year: 1995,
		tmdbId: 949,
		rating: 4.5,
		liked: true,
		rewatch: true,
		watchedDate: "2026-11-14",
		review: 'It\'s "perfect" & tense.',
		link: "https://letterboxd.com/u/film/heat/",
	});
	assert.equal(entries[1].title, "Amélie");
	assert.equal(entries[1].review, null, "plain watch entries have no review");
	assert.equal(entries[1].rating, null);
});

test("filmKey ignores case, accents and punctuation", () => {
	assert.equal(filmKey("Amélie", 2001), filmKey("amelie", 2001));
	assert.equal(filmKey("Love & Mercy", 2014), filmKey("Love and Mercy", 2014));
	assert.notEqual(filmKey("Dune", 1984), filmKey("Dune", 2021));
});

test("CSV import merges watched, diary, ratings, reviews, likes and watchlist", () => {
	const csv = (name: string, body: string) =>
		writeFileSync(join(work, name), body);
	csv(
		"watched.csv",
		"Date,Name,Year,Letterboxd URI\n2024-01-01,Heat,1995,https://boxd.it/a\n2024-01-02,Alien,1979,https://boxd.it/b\n",
	);
	csv(
		"diary.csv",
		"Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n2024-01-01,Heat,1995,x,5,,,2023-12-30\n2024-06-01,Heat,1995,y,5,Yes,,2024-05-31\n",
	);
	csv(
		"ratings.csv",
		"Date,Name,Year,Letterboxd URI,Rating\n2024-01-01,Heat,1995,x,5\n2024-01-02,Alien,1979,y,2\n",
	);
	csv(
		"reviews.csv",
		"Date,Name,Year,Letterboxd URI,Rating,Rewatch,Review,Tags,Watched Date\n2024-01-01,Heat,1995,x,5,,Perfect.,,2023-12-30\n",
	);
	mkdirSync(join(work, "likes"), { recursive: true });
	csv(
		"likes/films.csv",
		"Date,Name,Year,Letterboxd URI\n2024-01-01,Heat,1995,x\n",
	);
	csv(
		"watchlist.csv",
		"Date,Name,Year,Letterboxd URI\n2024-02-01,Ran,1985,https://boxd.it/c\n",
	);

	assert.equal(importLetterboxdCsv().imported, true);
	assert.equal(
		importLetterboxdCsv().imported,
		false,
		"unchanged files are skipped",
	);

	const heat = getDb()
		.prepare("SELECT * FROM film WHERE key = ?")
		.get(filmKey("Heat", 1995)) as Record<string, unknown>;
	assert.equal(heat.rating, 5);
	assert.equal(heat.liked, 1);
	assert.equal(heat.watched_at, "2024-05-31", "latest diary date wins");
	assert.equal(heat.rewatches, 1);
	assert.equal(heat.review, "Perfect.");
	assert.deepEqual(filmStats(), {
		watched: 2,
		watchlist: 1,
		rated: 2,
		unmatched: 3,
	});

	// Seeds need a TMDB id and a high rating.
	getDb()
		.prepare("UPDATE film SET tmdb_id = 949 WHERE key = ?")
		.run(filmKey("Heat", 1995));
	assert.deepEqual(
		filmSeeds().map((r) => ({ ...r })),
		[{ tmdbId: 949, title: "Heat" }],
	);

	const text = historyText();
	assert.match(text, /### Loved\n- Heat \(1995\) 5 ♥ \(rewatched 1x\)/);
	assert.match(text, /### Disliked[^\n]*\n- Alien \(1979\) 2/);
	assert.match(text, /### On their watchlist[^\n]*\n- Ran \(1985\)/);
});

test("a fresh export replaces the watchlist snapshot", () => {
	writeFileSync(
		join(work, "watchlist.csv"),
		"Date,Name,Year,Letterboxd URI\n2024-03-01,Stalker,1979,https://boxd.it/d\n",
	);
	importLetterboxdCsv(true);
	const wl = getDb()
		.prepare("SELECT name FROM film WHERE watchlist = 1")
		.all() as { name: string }[];
	assert.deepEqual(
		wl.map((r) => r.name),
		["Stalker"],
	);
});
