/**
 * SQLite connection and migration runner.
 *
 * node:sqlite rather than a native driver, so the Docker image needs no
 * build toolchain and the CLI runs with no node_modules at all.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.ts";
import { migrations } from "./migrations.ts";

let db: DatabaseSync | undefined;

export function getDb(): DatabaseSync {
	if (db) return db;
	mkdirSync(dirname(config.dbPath), { recursive: true });
	const conn = new DatabaseSync(config.dbPath);
	conn.exec("PRAGMA journal_mode = WAL");
	conn.exec("PRAGMA synchronous = NORMAL");
	conn.exec("PRAGMA foreign_keys = ON");
	conn.exec("PRAGMA busy_timeout = 5000");
	migrate(conn);
	db = conn;
	return db;
}

export function closeDb(): void {
	db?.close();
	db = undefined;
}

/** Apply any migration not yet recorded, in declaration order. */
export function migrate(conn: DatabaseSync): void {
	conn.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
		name       TEXT PRIMARY KEY,
		applied_at TEXT NOT NULL
	)`);
	const applied = new Set(
		(
			conn.prepare("SELECT name FROM schema_migration").all() as {
				name: string;
			}[]
		).map((r) => r.name),
	);
	for (const m of migrations) {
		if (applied.has(m.name)) continue;
		conn.exec("BEGIN");
		try {
			conn.exec(m.sql);
			conn
				.prepare(
					"INSERT INTO schema_migration (name, applied_at) VALUES (?, ?)",
				)
				.run(m.name, new Date().toISOString());
			conn.exec("COMMIT");
		} catch (error) {
			conn.exec("ROLLBACK");
			throw error;
		}
	}
}

/** Small key-value store for tokens, sync cursors and generated text. */
export function getSetting<T>(key: string): T | null {
	const row = getDb()
		.prepare("SELECT value FROM setting WHERE key = ?")
		.get(key) as { value: string } | undefined;
	return row ? (JSON.parse(row.value) as T) : null;
}

export function setSetting(key: string, value: unknown): void {
	getDb()
		.prepare(
			`INSERT INTO setting (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		)
		.run(key, JSON.stringify(value), new Date().toISOString());
}

export function deleteSetting(key: string): void {
	getDb().prepare("DELETE FROM setting WHERE key = ?").run(key);
}
