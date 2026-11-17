/**
 * Runtime configuration, read from the environment once.
 *
 * Server code imports only node: builtins and sibling modules, so the
 * maintenance CLI runs straight from TypeScript with Node's type stripping.
 * Nothing here throws on a missing key: each feature checks the one it needs
 * and says what to set, so a half-configured install still serves what it can.
 */

import { resolve } from "node:path";

const env = (name: string): string | undefined => {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
};

const list = (name: string): string[] =>
	(env(name) ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

export const config = {
	dbPath: resolve(env("COUCH_DB_PATH") ?? ".data/couch.db"),
	/** Folder holding the Letterboxd export CSVs (ratings.csv, reviews.csv). */
	letterboxdDir: resolve(env("COUCH_LETTERBOXD_DIR") ?? "data"),

	simklClientId: env("SIMKL_CLIENT_ID"),
	/** Public Letterboxd username, for the diary RSS feed. */
	letterboxdUsername: env("LETTERBOXD_USERNAME"),

	tmdbApiKey: env("TMDB_API_KEY"),
	countryCode: (env("STREAMING_COUNTRY_CODE") ?? "US").toUpperCase(),
	/** Streaming services you pay for, lower-cased TMDB provider names. */
	services: list("STREAMING_SERVICES").map((s) => s.toLowerCase()),

	openRouterApiKey: env("OPENROUTER_API_KEY"),
	/**
	 * Model that chooses picks. Default is a cheap, capable model (about $0.003
	 * a run); point it at something stronger to compare, e.g.
	 * anthropic/claude-sonnet-5.5 (~10x the cost). `picks --model` overrides it
	 * for one run.
	 */
	pickModel: env("OPENROUTER_PICK_MODEL") ?? "openai/gpt-5.6-luna",
	/** Model that summarises history into the taste profile; the cheapest that does it well. */
	profileModel: env("OPENROUTER_PROFILE_MODEL") ?? "anthropic/claude-haiku-5.5",

	/** Days without an episode before a "watching" show counts as stalled. */
	stalledAfterDays: Number(env("COUCH_STALLED_DAYS") ?? 42),
	/** Days without an episode before a paused show counts as a long break. */
	longBreakAfterDays: Number(env("COUCH_LONG_BREAK_DAYS") ?? 180),
};

export function requireConfig<K extends keyof typeof config>(
	key: K,
	envName: string,
	hint = "",
): NonNullable<(typeof config)[K]> {
	const value = config[key];
	if (value === undefined || value === null || value === "") {
		throw new Error(`${envName} is not set.${hint ? ` ${hint}` : ""}`);
	}
	return value as NonNullable<(typeof config)[K]>;
}
