/**
 * Work out what a video file is from its path. Pure: no IO, so it is easy to
 * test against real naming and to tune once the drives are connected.
 *
 * Handles the common layouts:
 *   Movies/Heat (1995)/Heat (1995).mkv          -> film "Heat" 1995
 *   Heat.1995.1080p.BluRay.x264.mkv             -> film "Heat" 1995
 *   Succession/Season 04/S04E09.mkv             -> Succession S4E9
 *   Succession (2018)/Season 4/Succession - S04E09 - Church and State.mkv
 *   Succession.S04E09E10.1080p.WEB.mkv          -> S4E9-10 (double episode)
 *   The Office/1x05.avi                         -> The Office S1E5
 *
 * Samples, extras and trailers are skipped.
 */

export const VIDEO_EXTENSIONS = new Set([
	".mkv",
	".mp4",
	".m4v",
	".avi",
	".mov",
	".wmv",
	".ts",
	".m2ts",
	".webm",
	".mpg",
	".mpeg",
	".flv",
]);

const SKIP_DIRS =
	/^(samples?|extras?|featurettes?|trailers?|behind the scenes|deleted scenes|interviews|shorts|bonus|subs|subtitles)$/i;
const SKIP_FILES = /(^|[\s._-])(sample|trailer)([\s._-]|$)/i;
const SEASON_DIR =
	/^(season|series|staffel|saison|temporada)[\s._-]*(\d{1,2})$|^s(\d{1,2})$/i;

/** Junk that follows the title in scene-style names. */
const RELEASE_TAGS =
	/\b(2160p|1080p|720p|576p|480p|4k|uhd|hdr|hdr10|dv|bluray|blu-ray|brrip|bdrip|webrip|web-dl|webdl|web|hdtv|dvdrip|dvd|remux|x264|x265|h264|h265|hevc|avc|aac|ac3|dts|ddp?5\.1|atmos|proper|repack|extended|unrated|imax|remastered|directors\.cut|multi|subbed|dubbed)\b/i;

export type ParsedMedia =
	| { kind: "movie"; title: string; year: number | null }
	| {
			kind: "episode";
			show: string;
			year: number | null;
			season: number;
			episode: number;
			/** Last episode of a multi-episode file (S01E01E02 -> 2). */
			episodeEnd: number;
	  };

function clean(s: string): string {
	return s
		.replace(/[._]+/g, " ")
		.replace(/\[[^\]]*\]/g, " ")
		.replace(/\s+-\s*$/, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Split "Title (2019)" / "Title 2019" into title and year. */
function titleYear(raw: string): { title: string; year: number | null } {
	const s = clean(raw);
	const paren = s.match(/^(.*?)\s*\((\d{4})\)\s*$/);
	if (paren) return { title: paren[1].trim(), year: Number(paren[2]) };
	// A trailing year, as long as something comes before it ("1917" alone is a title).
	const bare = s.match(/^(.+?)\s+((?:19|20)\d{2})$/);
	if (bare) return { title: bare[1].trim(), year: Number(bare[2]) };
	return { title: s, year: null };
}

/**
 * Scene-style names: cut at the first release tag, then take a trailing year.
 * Taking the year nearest the tags keeps titles like "Blade Runner 2049 (2017)"
 * intact.
 */
function sceneTitle(
	name: string,
): { title: string; year: number | null } | null {
	const s = name.replace(/[._]+/g, " ");
	const tag = s.search(RELEASE_TAGS);
	const head = clean(tag > 0 ? s.slice(0, tag) : s).replace(/[\s(]+$/, "");
	const m = head.match(/^(.+?)[\s(]+((?:19|20)\d{2})\)?$/);
	if (m) return { title: clean(m[1]), year: Number(m[2]) };
	return tag > 0 ? { title: head, year: null } : null;
}

const EPISODE = [
	// S01E02, S01E02E03, S01E02-E03, s1e2
	/(?:^|[^a-z0-9])s(\d{1,2})[\s._-]*e(\d{1,3})(?:[\s._-]*-?[\s._-]*e(\d{1,3}))?/i,
	// 1x02
	/(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?:[^0-9]|$)/i,
];

export function parseMediaPath(path: string): ParsedMedia | null {
	const parts = path.split(/[/\\]+/).filter(Boolean);
	const file = parts.at(-1);
	if (!file) return null;
	const dot = file.lastIndexOf(".");
	const ext = dot >= 0 ? file.slice(dot).toLowerCase() : "";
	if (!VIDEO_EXTENSIONS.has(ext)) return null;
	const dirs = parts.slice(0, -1);
	if (dirs.some((d) => SKIP_DIRS.test(d)) || SKIP_FILES.test(file)) return null;
	const base = file.slice(0, dot);

	// ---- episodes
	for (const re of EPISODE) {
		const m = base.match(re);
		if (!m || m.index === undefined) continue;
		const season = Number(m[1]);
		const episode = Number(m[2]);
		const episodeEnd = m[3] ? Number(m[3]) : episode;
		// Show name: the folder above a "Season NN" folder; otherwise the text
		// before SxxEyy in the file name; otherwise the folder holding the file.
		const seasonIdx = dirs.findLastIndex((d) => SEASON_DIR.test(clean(d)));
		const before = clean(base.slice(0, m.index)).replace(/\s*-$/, "");
		let showRaw: string | undefined;
		if (seasonIdx > 0) showRaw = dirs[seasonIdx - 1];
		else if (before) showRaw = before;
		else if (seasonIdx < 0) showRaw = dirs.at(-1);
		if (!showRaw) return null;
		const { title, year } = titleYear(showRaw);
		if (!title) return null;
		return { kind: "episode", show: title, year, season, episode, episodeEnd };
	}

	// ---- films: prefer a "Title (Year)" folder, then the file name.
	const folder = dirs.at(-1);
	if (folder) {
		const f = titleYear(folder);
		if (f.year) return { kind: "movie", title: f.title, year: f.year };
	}
	const paren = titleYear(base);
	if (paren.year && /\(\d{4}\)/.test(base)) return { kind: "movie", ...paren };
	const scene = sceneTitle(base);
	if (scene?.title) return { kind: "movie", ...scene };
	const plain = titleYear(base);
	return plain.title ? { kind: "movie", ...plain } : null;
}
