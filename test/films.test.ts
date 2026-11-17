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

test("parseListPage reads plain and ranked list items in order, across pages", async () => {
	const { parseListPage } = await import("../src/server/lists.ts");
	const html = `<meta property="og:title" content="MCU &amp; friends">
<li class="posteritem numbered-list-item" data-item-slug="iron-man-2008" data-item-full-display-name="Iron Man (2008)" data-list-index="100"></li>
<li class="posteritem" data-item-slug="the-incredible-hulk" data-item-full-display-name="The Incredible Hulk (2008)" data-list-index="101"></li>
<li class="posteritem" data-item-slug="untitled" data-item-full-display-name="Untitled Project" data-list-index="102"></li>
<a href="/u/list/mcu/page/2/">2</a><a href="/u/list/mcu/page/3/">3</a>`;
	const page = parseListPage(html);
	assert.equal(page.name, "MCU & friends");
	assert.equal(page.lastPage, 3);
	assert.deepEqual(
		page.items.map((i) => [i.index, i.slug, i.name, i.year]),
		[
			[100, "iron-man-2008", "Iron Man", 2008],
			[101, "the-incredible-hulk", "The Incredible Hulk", 2008],
			[102, "untitled", "Untitled Project", null],
		],
	);
});

test("list progress counts watched films and finds the next one in order", async () => {
	const { followList, listProgress } = await import("../src/server/lists.ts");
	const id = followList("https://letterboxd.com/u/list/test/", "added");
	const db = getDb();
	db.prepare("UPDATE list SET name = 'Test' WHERE id = ?").run(id);
	const add = db.prepare(
		"INSERT INTO list_item (list_id, position, slug, name, year, tmdb_id) VALUES (?, ?, ?, ?, ?, ?)",
	);
	add.run(id, 1, "heat", "Heat", 1995, 949); // watched, matched by TMDB id
	add.run(id, 2, "alien", "Alien", 1979, null); // watched, matched by title|year
	add.run(id, 3, "ran", "Ran", 1985, null); // not watched -> next
	add.run(id, 4, "stalker", "Stalker", 1979, null);
	const l = listProgress().find((x) => x.id === id);
	assert.equal(l?.watched, 2);
	assert.equal(l?.total, 4);
	assert.deepEqual(
		{ ...l?.next },
		{ position: 3, name: "Ran", year: 1985, tmdbId: null },
	);
});
