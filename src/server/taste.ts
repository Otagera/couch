/**
 * Taste profile: one LLM call that reads the user's whole history (Simkl TV,
 * Letterboxd films and reviews, feedback on past picks) and writes a short
 * plain-language profile. It is stored and reused by every pick run, and is
 * rebuilt only when the inputs change, so it costs almost nothing over time.
 *
 * The profile is shown in the UI on purpose: if it reads wrong, the picks
 * will be wrong, and the user can see why.
 */

import { createHash } from "node:crypto";
import { config } from "./config.ts";
import { getDb, getSetting, setSetting } from "./db/index.ts";
import { chat } from "./llm.ts";
import { createLogger } from "./log.ts";
import { cachedShow } from "./tmdb.ts";

const log = createLogger("taste");

const PROFILE = "taste.profile";
const NOTES = "taste.notes";

/** The viewer's own corrections ("I'm tired of true crime"), always included. */
export function getNotes(): string {
	return getSetting<string>(NOTES) ?? "";
}

export function setNotes(notes: string): void {
	setSetting(NOTES, notes.trim());
}

export interface TasteProfile {
	text: string;
	model: string;
	createdAt: string;
	inputHash: string;
	costUsd: number | null;
}

export function getProfile(): TasteProfile | null {
	return getSetting<TasteProfile>(PROFILE);
}

/** The history the profile is written from, as compact text. */
export function historyText(): string {
	const db = getDb();
	const shows = db
		.prepare(
			"SELECT title, year, tmdb_id, status, user_rating, watched_episodes, total_episodes, not_aired FROM show ORDER BY user_rating DESC NULLS LAST, title",
		)
		.all() as {
		title: string;
		year: number | null;
		tmdb_id: number | null;
		status: string;
		user_rating: number | null;
		watched_episodes: number;
		total_episodes: number;
		not_aired: number;
	}[];

	const line = (s: (typeof shows)[number]) => {
		const genres = s.tmdb_id ? cachedShow(s.tmdb_id)?.genres.join("/") : "";
		const rating = s.user_rating ? ` ${s.user_rating}/10` : "";
		const progress =
			s.status === "dropped" || s.status === "hold"
				? ` (stopped at ${s.watched_episodes}/${s.total_episodes - s.not_aired} eps)`
				: "";
		return `- ${s.title}${s.year ? ` (${s.year})` : ""}${rating}${progress}${genres ? ` [${genres}]` : ""}`;
	};
	const section = (title: string, status: string) => {
		const rows = shows.filter((s) => s.status === status);
		return rows.length ? `### ${title}\n${rows.map(line).join("\n")}` : "";
	};

	type FilmRow = {
		name: string;
		year: number | null;
		rating: number | null;
		liked: number;
		review: string | null;
		watched_at: string | null;
		rewatches: number;
	};
	const filmRows = (where: string, order: string, limit: number) =>
		db
			.prepare(
				`SELECT name, year, rating, liked, review, watched_at, rewatches FROM film WHERE ${where} ORDER BY ${order} LIMIT ${limit}`,
			)
			.all() as FilmRow[];
	const film = (f: FilmRow) =>
		`- ${f.name}${f.year ? ` (${f.year})` : ""}${f.rating ? ` ${f.rating}` : ""}${f.liked ? " ♥" : ""}${f.rewatches ? ` (rewatched ${f.rewatches}x)` : ""}`;
	const loved = filmRows(
		"watched = 1 AND (rating >= 4.5 OR (liked = 1 AND rating >= 4))",
		"rating DESC, watched_at DESC",
		120,
	);
	const disliked = filmRows(
		"watched = 1 AND rating <= 2",
		"rating, watched_at DESC",
		60,
	);
	const recent = filmRows(
		"watched = 1 AND watched_at IS NOT NULL",
		"watched_at DESC",
		25,
	);
	const reviews = filmRows(
		"review IS NOT NULL AND review != ''",
		"watched_at DESC NULLS LAST",
		150,
	);
	const wanted = filmRows(
		"watchlist = 1 AND watched = 0",
		"watchlist_at DESC",
		40,
	);

	const feedback = db
		.prepare(
			`SELECT p.title, p.feedback, r.kind, MAX(p.feedback_at) AS at
			 FROM pick p JOIN pick_run r ON r.id = p.run_id
			 WHERE p.feedback IS NOT NULL GROUP BY r.kind, p.tmdb_id ORDER BY at DESC`,
		)
		.all() as { title: string; feedback: number; kind: string }[];

	const lists = db
		.prepare(
			"SELECT name, items FROM list WHERE hidden = 0 AND name IS NOT NULL ORDER BY origin, name",
		)
		.all() as { name: string; items: number }[];

	const notes = getNotes();

	return [
		notes
			? `## Notes from the viewer (these override anything inferred)\n${notes}`
			: "",
		"## TV (from Simkl; ratings are out of 10)",
		section("Watching", "watching"),
		section("Completed", "completed"),
		section("On hold", "hold"),
		section("Dropped", "dropped"),
		section("Plan to watch", "plantowatch"),
		"## Films (from Letterboxd; ratings are out of 5, ♥ = liked)",
		loved.length ? `### Loved\n${loved.map(film).join("\n")}` : "",
		disliked.length
			? `### Disliked (2 or less)\n${disliked.map(film).join("\n")}`
			: "",
		recent.length
			? `### Watched most recently\n${recent.map(film).join("\n")}`
			: "",
		reviews.length
			? `### Their own film reviews\n${reviews
					.map(
						(r) =>
							`- ${r.name} (${r.year}${r.rating ? `, ${r.rating}/5` : ""}): ${(r.review ?? "").replace(/\s+/g, " ").slice(0, 400)}`,
					)
					.join("\n")}`
			: "",
		wanted.length
			? `### On their watchlist (most recently added)\n${wanted.map(film).join("\n")}`
			: "",
		lists.length
			? `## Letterboxd lists they follow\n${lists.map((l) => `- ${l.name} (${l.items} films)`).join("\n")}`
			: "",
		feedback.length
			? `## Feedback on earlier recommendations\n${feedback
					.map(
						(f) =>
							`- ${f.title}: ${f.feedback > 0 ? "liked the suggestion" : "did not want this"}`,
					)
					.join("\n")}`
			: "",
	]
		.filter(Boolean)
		.join("\n\n");
}

const SYSTEM = `You write a viewer's TV and film taste profile for a recommendation system.
Read their history and write a profile other models will use to choose shows and films for them.

Write in plain second person ("You like...") in under 550 words, with these headings:
## What you love
## What tends to lose you
## TV: format and pacing
## Film: what you seek out
## Moods you come back to

Be specific: name tones, themes, structures, directors and examples from their history.
Treat dropped and on-hold shows, low ratings and rejected suggestions as real signal. Shows
they are "watching" but have not touched in months are usually a pause, not a dislike.
Their own reviews are the strongest evidence of why they like things. Do not recommend titles.`;

function historyHash(history: string): string {
	return createHash("sha256").update(history).digest("hex").slice(0, 16);
}

/** True when the history has changed since the profile was written. */
export function profileIsStale(): boolean {
	return getProfile()?.inputHash !== historyHash(historyText());
}

export async function buildProfile(
	force = false,
): Promise<{ profile: TasteProfile; rebuilt: boolean }> {
	const history = historyText();
	const inputHash = historyHash(history);
	const existing = getProfile();
	if (!force && existing?.inputHash === inputHash)
		return { profile: existing, rebuilt: false };

	const result = await chat(
		config.profileModel,
		[
			{ role: "system", content: SYSTEM },
			{ role: "user", content: history },
		],
		{ maxTokens: 1800 },
	);
	const profile: TasteProfile = {
		text: result.text.trim(),
		model: result.model,
		createdAt: new Date().toISOString(),
		inputHash,
		costUsd: result.costUsd,
	};
	setSetting(PROFILE, profile);
	log.info("PROFILE_BUILT", {
		model: profile.model,
		costUsd: profile.costUsd,
		inputHash,
	});
	return { profile, rebuilt: true };
}
