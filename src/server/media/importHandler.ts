/**
 * POST /api/media/import -- the media scanner, run on the machine with the
 * drives, sends its parsed file list here when Couch is deployed elsewhere.
 * Authenticated with the scanner token (Passkeys page), not a session.
 */

import { defineEventHandler } from "h3";
import { scannerTokenValid } from "../auth/store.ts";
import { createLogger } from "../log.ts";
import { importDrive, type ScanResult } from "./index.ts";

const log = createLogger("media");

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
	const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
	if (!scannerTokenValid(token))
		return json({ error: "Invalid scanner token." }, 401);
	let scan: ScanResult;
	try {
		scan = (await req.json()) as ScanResult;
	} catch {
		return json({ error: "Body must be JSON." }, 400);
	}
	if (!scan?.drive || !Array.isArray(scan.files))
		return json({ error: "Expected { drive, root, files }." }, 400);
	if (scan.files.length > 200_000)
		return json({ error: "Too many files in one import." }, 413);
	try {
		return json(
			await importDrive({
				drive: String(scan.drive).slice(0, 100),
				root: String(scan.root ?? ""),
				files: scan.files,
			}),
		);
	} catch (error) {
		log.error("MEDIA_IMPORT_FAILED", { drive: scan.drive }, error);
		return json(
			{ error: error instanceof Error ? error.message : "Import failed." },
			500,
		);
	}
});
