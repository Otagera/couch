/**
 * Letterboxd export CSVs. Films only feed the taste profile: what someone
 * loves in film says a lot about what TV they will like.
 *
 * Read from COUCH_LETTERBOXD_DIR (default ./data). Missing files are fine.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

export interface FilmRating {
	name: string;
	year: number | null;
	rating: number; // 0.5 - 5
	date: string;
}

export interface FilmReview extends FilmRating {
	review: string;
}

/** RFC 4180 parser: quoted fields, escaped quotes, newlines inside quotes. */
export function parseCsv(text: string): Record<string, string>[] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === '"' && text[i + 1] === '"') {
				field += '"';
				i++;
			} else if (c === '"') quoted = false;
			else field += c;
		} else if (c === '"') quoted = true;
		else if (c === ",") {
			row.push(field);
			field = "";
		} else if (c === "\n" || c === "\r") {
			if (c === "\r" && text[i + 1] === "\n") i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else field += c;
	}
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	const [header, ...body] = rows.filter((r) => r.some((f) => f !== ""));
	if (!header) return [];
	return body.map((r) =>
		Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ""])),
	);
}

function read(file: string): Record<string, string>[] {
	const path = join(config.letterboxdDir, file);
	return existsSync(path) ? parseCsv(readFileSync(path, "utf8")) : [];
}

const toRating = (r: Record<string, string>): FilmRating => ({
	name: r.Name,
	year: r.Year ? Number(r.Year) : null,
	rating: Number(r.Rating),
	date: r["Watched Date"] || r.Date,
});

export function filmRatings(): FilmRating[] {
	return read("ratings.csv")
		.map(toRating)
		.filter((r) => r.name && r.rating > 0);
}

export function filmReviews(): FilmReview[] {
	return read("reviews.csv")
		.map((r) => ({ ...toRating(r), review: (r.Review ?? "").trim() }))
		.filter((r) => r.name && r.review);
}
