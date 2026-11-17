import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const work = mkdtempSync(join(tmpdir(), "couch-media-"));
process.env.COUCH_DB_PATH = join(work, "couch.db");

const { closeDb, getDb } = await import("../src/server/db/index.ts");
const media = await import("../src/server/media/index.ts");

after(() => {
	closeDb();
	rmSync(work, { recursive: true, force: true });
});

const drive = join(work, "Drive A");
const touch = (rel: string) => {
	const p = join(drive, rel);
	mkdirSync(join(p, ".."), { recursive: true });
	writeFileSync(p, "x");
};

// Pre-seed TMDB matches so the test never touches the network.
function seed(
	kind: string,
	title: string,
	year: number | null,
	id: number | null,
) {
	getDb()
		.prepare(
			"INSERT OR REPLACE INTO media_match (kind, title, year, tmdb_id, matched_at) VALUES (?, ?, ?, ?, ?)",
		)
		.run(kind, title, year ?? 0, id, new Date().toISOString());
}

test("scan skips hidden folders, non-video files and extras", () => {
	touch("Movies/Heat (1995)/Heat (1995).mkv");
	touch("Movies/Heat (1995)/Extras/Featurette.mkv");
	touch("TV/Succession/Season 04/S04E09.mkv");
	touch("TV/Succession/Season 04/S04E10.mkv");
	touch("TV/Succession/Season 03/S03E01E02.mkv");
	touch(".Trashes/old.mkv");
	touch("notes.txt");
	const scan = media.scanDirectory(drive);
	assert.equal(scan.drive, "Drive A");
	assert.equal(scan.files.length, 5, "hidden folder and .txt are skipped");
	assert.equal(
		scan.files.filter((f) => !f.parsed).length,
		1,
		"the extra is listed but not parsed",
	);
});

test("import matches titles, records episodes per show, and summarises coverage", async () => {
	seed("movie", "Heat", 1995, 949);
	seed("tv", "Succession", null, 76331);
	const r = await media.importDrive(media.scanDirectory(drive));
	assert.deepEqual(
		{
			files: r.files,
			movies: r.movies,
			episodes: r.episodes,
			shows: r.shows,
			unparsed: r.unparsed,
		},
		{ files: 4, movies: 1, episodes: 3, shows: 1, unparsed: 1 },
	);
	assert.deepEqual(media.localMovies().get(949), ["Drive A"]);
	const show = media.localShows().get(76331);
	assert.ok(show);
	assert.deepEqual([...show.episodes].sort(), [
		"S03E01",
		"S03E02",
		"S04E09",
		"S04E10",
	]);
	assert.equal(media.showCoverage(show), "S3–S4 · 4 eps");
	assert.equal(media.listDrives()[0].files, 4);
});

test("rescanning a drive replaces its files", async () => {
	rmSync(join(drive, "Movies"), { recursive: true });
	await media.importDrive(media.scanDirectory(drive));
	assert.equal(media.localMovies().size, 0);
	media.forgetDrive("Drive A");
	assert.equal(media.localShows().size, 0);
	assert.equal(media.listDrives().length, 0);
});
