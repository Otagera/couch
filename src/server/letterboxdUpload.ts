/**
 * POST /api/letterboxd/upload -- the Letterboxd export zip, uploaded from the
 * browser. Behind the sign-in gate like every non-public route.
 *
 * Only known export files are written, into COUCH_LETTERBOXD_DIR, under
 * fixed names: nothing in the zip chooses where a file lands, so a crafted
 * archive can't write elsewhere ("zip slip"). The CSVs are imported at once;
 * TMDB matching and lists then run as a background sync.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineEventHandler } from "h3";
import { config } from "./config.ts";
import { filmStats, importLetterboxdCsv } from "./films.ts";
import { createLogger } from "./log.ts";
import { syncAll } from "./sync.ts";
import { readZip } from "./zip.ts";

const log = createLogger("letterboxd");
const MAX_UPLOAD = 60 * 1024 * 1024;

const ALLOWED = [
	/^(watched|diary|ratings|reviews|watchlist|profile|comments)\.csv$/,
	/^likes\/(films|lists|reviews)\.csv$/,
	/^lists\/[a-z0-9][a-z0-9._-]*\.csv$/,
];

/** Pick the export files out of a zip; returns { relative path -> contents }. */
export function exportFiles(
	entries: { name: string; data: Buffer }[],
): Map<string, Buffer> {
	// Some exports nest everything in one top-level folder; strip it.
	const names = entries.map((e) => e.name.replace(/\\/g, "/"));
	const tops = new Set(
		names.map((n) => (n.includes("/") ? n.split("/")[0] : "")),
	);
	const prefix =
		tops.size === 1 && !tops.has("") && !names.includes("watched.csv")
			? `${[...tops][0]}/`
			: "";
	const out = new Map<string, Buffer>();
	entries.forEach((e, i) => {
		const rel = names[i].startsWith(prefix)
			? names[i].slice(prefix.length)
			: names[i];
		const lower = rel.toLowerCase();
		if (ALLOWED.some((re) => re.test(lower))) out.set(lower, e.data);
	});
	return out;
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
		},
	});

export default defineEventHandler(async (event) => {
	const req = event.req as Request;
	if (req.method !== "POST") return json({ error: "POST only" }, 405);
	if (Number(req.headers.get("content-length") ?? 0) > MAX_UPLOAD)
		return json({ error: "That file is too large." }, 413);

	let files: Map<string, Buffer>;
	try {
		const buf = Buffer.from(await req.arrayBuffer());
		if (buf.length > MAX_UPLOAD)
			return json({ error: "That file is too large." }, 413);
		files = exportFiles(readZip(buf));
	} catch (error) {
		return json(
			{
				error:
					error instanceof Error ? error.message : "Couldn't read that zip.",
			},
			400,
		);
	}
	if (!files.has("watched.csv") && !files.has("ratings.csv")) {
		return json(
			{
				error:
					"That doesn't look like a Letterboxd export (no watched.csv or ratings.csv).",
			},
			400,
		);
	}

	const dir = config.letterboxdDir;
	mkdirSync(dir, { recursive: true });
	// Your own lists are replaced wholesale, so deleted lists disappear.
	if ([...files.keys()].some((f) => f.startsWith("lists/"))) {
		try {
			for (const f of readdirSync(join(dir, "lists")))
				if (f.endsWith(".csv")) rmSync(join(dir, "lists", f));
		} catch {
			// No lists folder yet.
		}
	}
	for (const [rel, data] of files) {
		const target = join(dir, rel);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, data);
	}

	const imported = importLetterboxdCsv(true);
	log.info("LETTERBOXD_EXPORT_UPLOADED", {
		files: files.size,
		films: imported.films,
	});
	// TMDB matching, posters and lists take a while; don't hold the request.
	void syncAll().catch(() => {
		// syncAll logs its own failures.
	});
	return json({ files: files.size, stats: filmStats() });
});
