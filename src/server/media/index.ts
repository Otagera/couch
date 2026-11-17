/**
 * Local media: video files on the user's own drives.
 *
 *   scanDirectory()  walk a folder and parse every video file (no network)
 *   importDrive()    match parsed files to TMDB and store them for a drive
 *
 * The scan runs wherever the drives are plugged in. When Couch is deployed,
 * the CLI sends the parsed list to the server (see /api/media/import) and the
 * server does the matching, so the scanning machine needs no API keys.
 *
 * Dependency-free (node: builtins only), like the rest of the CLI path.
 */

import { readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { getDb } from "../db/index.ts";
import { createLogger } from "../log.ts";
import { findShowId } from "../tmdb.ts";
import { findMovieId } from "../tmdbMovies.ts";
import { type ParsedMedia, parseMediaPath, VIDEO_EXTENSIONS } from "./parse.ts";

const log = createLogger("media");

const SKIP_DIR_NAMES = new Set([
	"$RECYCLE.BIN",
	"System Volume Information",
	"lost+found",
	"node_modules",
]);

export interface ScannedFile {
	path: string; // relative to the scan root
	size: number;
	parsed: ParsedMedia | null;
}

export interface ScanResult {
	drive: string;
	root: string;
	files: ScannedFile[];
}

/** Walk a folder for video files. Hidden folders and system folders are skipped. */
export function scanDirectory(
	root: string,
	drive = basename(root) || root,
): ScanResult {
	const files: ScannedFile[] = [];
	const walk = (dir: string) => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch (error) {
			log.warn("MEDIA_DIR_UNREADABLE", { dir }, error);
			return;
		}
		for (const e of entries) {
			if (e.name.startsWith(".") || SKIP_DIR_NAMES.has(e.name)) continue;
			const full = join(dir, e.name);
			if (e.isDirectory()) walk(full);
			else if (e.isFile()) {
				const ext = e.name.slice(e.name.lastIndexOf(".")).toLowerCase();
				if (!VIDEO_EXTENSIONS.has(ext)) continue;
				const rel = relative(root, full);
				let size = 0;
				try {
					size = statSync(full).size;
				} catch {
					// Unreadable file: keep it with size 0.
				}
				files.push({ path: rel, size, parsed: parseMediaPath(rel) });
			}
		}
	};
	walk(root);
	return { drive, root, files };
}

// --------------------------------------------------------------- matching

async function matchTitle(
	kind: "movie" | "tv",
	title: string,
	year: number | null,
): Promise<number | null> {
	const db = getDb();
	const cached = db
		.prepare(
			"SELECT tmdb_id FROM media_match WHERE kind = ? AND title = ? AND year = ?",
		)
		.get(kind, title, year ?? 0) as { tmdb_id: number | null } | undefined;
	if (cached) return cached.tmdb_id;
	const id =
		kind === "movie"
			? await findMovieId(title, year)
			: await findShowId(title, year);
	db.prepare(
		"INSERT OR REPLACE INTO media_match (kind, title, year, tmdb_id, matched_at) VALUES (?, ?, ?, ?, ?)",
	).run(kind, title, year ?? 0, id, new Date().toISOString());
	return id;
}

export interface ImportResult {
	drive: string;
	files: number;
	movies: number;
	episodes: number;
	shows: number;
	unparsed: number;
	unmatched: { kind: string; title: string; year: number | null }[];
}

/** Store a drive's files (replacing its previous scan), matched to TMDB. */
export async function importDrive(scan: ScanResult): Promise<ImportResult> {
	const files = scan.files.filter((f) => f.parsed);
	// One TMDB lookup per distinct title, a few at a time.
	const titles = new Map<
		string,
		{ kind: "movie" | "tv"; title: string; year: number | null }
	>();
	for (const f of files) {
		const p = f.parsed as ParsedMedia;
		const t =
			p.kind === "movie"
				? { kind: "movie" as const, title: p.title, year: p.year }
				: { kind: "tv" as const, title: p.show, year: p.year };
		titles.set(`${t.kind}|${t.title}|${t.year ?? ""}`, t);
	}
	const ids = new Map<string, number | null>();
	const queue = [...titles.entries()];
	await Promise.all(
		Array.from({ length: 6 }, async () => {
			for (let item = queue.shift(); item; item = queue.shift()) {
				const [key, t] = item;
				try {
					ids.set(key, await matchTitle(t.kind, t.title, t.year));
				} catch (error) {
					log.warn("MEDIA_MATCH_FAILED", t, error);
					ids.set(key, null);
				}
			}
		}),
	);

	const db = getDb();
	db.exec("BEGIN");
	try {
		db.prepare(
			`INSERT INTO media_drive (name, root, files, unmatched, scanned_at) VALUES (?, ?, 0, 0, ?)
			 ON CONFLICT(name) DO UPDATE SET root = excluded.root, scanned_at = excluded.scanned_at`,
		).run(scan.drive, scan.root, new Date().toISOString());
		db.prepare("DELETE FROM media_file WHERE drive = ?").run(scan.drive);
		const insert = db.prepare(
			`INSERT OR REPLACE INTO media_file (drive, path, kind, title, year, season, episode, episode_end, tmdb_id, size)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const f of files) {
			const p = f.parsed as ParsedMedia;
			if (p.kind === "movie") {
				insert.run(
					scan.drive,
					f.path,
					"movie",
					p.title,
					p.year,
					null,
					null,
					null,
					ids.get(`movie|${p.title}|${p.year ?? ""}`) ?? null,
					f.size,
				);
			} else {
				insert.run(
					scan.drive,
					f.path,
					"episode",
					p.show,
					p.year,
					p.season,
					p.episode,
					p.episodeEnd,
					ids.get(`tv|${p.show}|${p.year ?? ""}`) ?? null,
					f.size,
				);
			}
		}
		const unmatched = [...titles.entries()]
			.filter(([k]) => !ids.get(k))
			.map(([, t]) => t);
		db.prepare(
			"UPDATE media_drive SET files = ?, unmatched = ? WHERE name = ?",
		).run(files.length, unmatched.length, scan.drive);
		db.exec("COMMIT");
		const result: ImportResult = {
			drive: scan.drive,
			files: files.length,
			movies: files.filter((f) => f.parsed?.kind === "movie").length,
			episodes: files.filter((f) => f.parsed?.kind === "episode").length,
			shows: [...titles.values()].filter((t) => t.kind === "tv").length,
			unparsed: scan.files.length - files.length,
			unmatched,
		};
		log.info("MEDIA_DRIVE_IMPORTED", {
			...result,
			unmatched: unmatched.length,
		});
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

// ---------------------------------------------------------------- queries

export interface DriveInfo {
	name: string;
	root: string | null;
	files: number;
	unmatched: number;
	scannedAt: string;
}

export function listDrives(): DriveInfo[] {
	return (
		getDb()
			.prepare(
				"SELECT name, root, files, unmatched, scanned_at FROM media_drive ORDER BY name",
			)
			.all() as {
			name: string;
			root: string | null;
			files: number;
			unmatched: number;
			scanned_at: string;
		}[]
	).map((d) => ({
		name: d.name,
		root: d.root,
		files: d.files,
		unmatched: d.unmatched,
		scannedAt: d.scanned_at,
	}));
}

export function forgetDrive(name: string): void {
	getDb().prepare("DELETE FROM media_drive WHERE name = ?").run(name);
}

/** TMDB movie id -> drive names it's on. */
export function localMovies(): Map<number, string[]> {
	const out = new Map<number, string[]>();
	for (const r of getDb()
		.prepare(
			"SELECT DISTINCT tmdb_id, drive FROM media_file WHERE kind = 'movie' AND tmdb_id IS NOT NULL",
		)
		.all() as { tmdb_id: number; drive: string }[]) {
		out.set(r.tmdb_id, [...(out.get(r.tmdb_id) ?? []), r.drive]);
	}
	return out;
}

export interface LocalShow {
	drives: string[];
	/** "S04E09" codes present on any drive. */
	episodes: Set<string>;
	/** Episodes on disk per season. */
	perSeason: Map<number, number>;
}

export const episodeCode = (season: number, episode: number) =>
	`S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;

/** TMDB TV id -> which episodes are on which drives. */
export function localShows(): Map<number, LocalShow> {
	const out = new Map<number, LocalShow>();
	for (const r of getDb()
		.prepare(
			"SELECT tmdb_id, drive, season, episode, episode_end FROM media_file WHERE kind = 'episode' AND tmdb_id IS NOT NULL",
		)
		.all() as {
		tmdb_id: number;
		drive: string;
		season: number;
		episode: number;
		episode_end: number | null;
	}[]) {
		const s: LocalShow = out.get(r.tmdb_id) ?? {
			drives: [],
			episodes: new Set<string>(),
			perSeason: new Map(),
		};
		if (!s.drives.includes(r.drive)) s.drives.push(r.drive);
		for (let e = r.episode; e <= (r.episode_end ?? r.episode); e++) {
			const code = episodeCode(r.season, e);
			if (!s.episodes.has(code)) {
				s.episodes.add(code);
				s.perSeason.set(r.season, (s.perSeason.get(r.season) ?? 0) + 1);
			}
		}
		out.set(r.tmdb_id, s);
	}
	return out;
}

/** "S1-S3 · 30 eps" style summary of what's on disk for a show. */
export function showCoverage(s: LocalShow): string {
	const seasons = [...s.perSeason.keys()].sort((a, b) => a - b);
	const first = seasons[0];
	const last = seasons[seasons.length - 1];
	const contiguous = seasons.length > 1 && last - first === seasons.length - 1;
	const range = contiguous
		? `S${first}–S${last}`
		: seasons.map((n) => `S${n}`).join(", ");
	return `${range} · ${s.episodes.size} ep${s.episodes.size === 1 ? "" : "s"}`;
}
