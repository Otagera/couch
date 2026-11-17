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
	{
		name: "002_films",
		sql: `
		-- Picks are now either TV or films; TMDB ids overlap between the two.
		ALTER TABLE pick_run ADD COLUMN kind TEXT NOT NULL DEFAULT 'tv';

		-- One row per film the user has watched, rated, liked or wants to watch.
		-- Letterboxd has no API: rows come from the CSV export (full history,
		-- watchlist) and the public diary RSS feed (recent entries). Keyed by
		-- normalised "title|year" because the two sources share no other id.
		CREATE TABLE film (
			key            TEXT PRIMARY KEY,
			name           TEXT NOT NULL,
			year           INTEGER,
			tmdb_id        INTEGER,
			letterboxd_uri TEXT,
			rating         REAL,
			liked          INTEGER NOT NULL DEFAULT 0,
			watched        INTEGER NOT NULL DEFAULT 0,
			watched_at     TEXT,
			rewatches      INTEGER NOT NULL DEFAULT 0,
			watchlist      INTEGER NOT NULL DEFAULT 0,
			watchlist_at   TEXT,
			review         TEXT,
			tmdb_lookup_at TEXT,
			updated_at     TEXT NOT NULL
		);
		CREATE INDEX film_tmdb ON film (tmdb_id);

		CREATE TABLE tmdb_movie (
			tmdb_id    INTEGER PRIMARY KEY,
			details    TEXT NOT NULL,
			fetched_at TEXT NOT NULL
		);
		`,
	},
];
