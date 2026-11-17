/**
 * Schema migrations, applied in order and recorded by name. Never edit one
 * that has shipped; add a new one.
 */

export const migrations: Array<{ name: string; sql: string }> = [
	{
		name: "001_initial",
		sql: `
		CREATE TABLE setting (
			key        TEXT PRIMARY KEY,
			value      TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		-- One row per show in the user's Simkl library (mirrors /sync/all-items/shows).
		CREATE TABLE show (
			simkl_id         INTEGER PRIMARY KEY,
			slug             TEXT NOT NULL,
			title            TEXT NOT NULL,
			year             INTEGER,
			tmdb_id          INTEGER,
			imdb_id          TEXT,
			tvdb_id          TEXT,
			status           TEXT NOT NULL,
			user_rating      INTEGER,
			rated_at         TEXT,
			added_at         TEXT,
			last_watched_at  TEXT,
			last_watched     TEXT,
			next_to_watch    TEXT,
			watched_episodes INTEGER NOT NULL DEFAULT 0,
			total_episodes   INTEGER NOT NULL DEFAULT 0,
			not_aired        INTEGER NOT NULL DEFAULT 0,
			synced_at        TEXT NOT NULL
		);
		CREATE INDEX show_tmdb ON show (tmdb_id);
		CREATE INDEX show_status ON show (status);

		-- TMDB details for any show we display: library shows and candidates.
		CREATE TABLE tmdb_show (
			tmdb_id    INTEGER PRIMARY KEY,
			details    TEXT NOT NULL,
			providers  TEXT,
			fetched_at TEXT NOT NULL
		);

		CREATE TABLE pick_run (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			created_at TEXT NOT NULL,
			model      TEXT NOT NULL,
			candidates INTEGER NOT NULL,
			note       TEXT
		);

		CREATE TABLE pick (
			run_id      INTEGER NOT NULL REFERENCES pick_run(id) ON DELETE CASCADE,
			rank        INTEGER NOT NULL,
			tmdb_id     INTEGER NOT NULL,
			title       TEXT NOT NULL,
			reason      TEXT NOT NULL,
			feedback    INTEGER,
			feedback_at TEXT,
			PRIMARY KEY (run_id, tmdb_id)
		);
		CREATE INDEX pick_tmdb ON pick (tmdb_id);
		`,
	},
];
