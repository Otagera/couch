/**
 * Passkeys, sessions and one-time codes. Dependency-free on purpose: the
 * maintenance CLI imports this (`passkeys list|reset`) and runs with no
 * node_modules. The WebAuthn ceremony itself lives in handlers.ts.
 *
 * Auth is on when COUCH_SETUP_CODE is set (COUCH_AUTH_PASSWORD is accepted
 * for older configs). That code is only ever used to register the first
 * passkey, or after a reset; once a passkey exists, sign-in is passkey-only.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { deleteSetting, getDb, getSetting, setSetting } from "../db/index.ts";

export const SESSION_COOKIE = "couch_session";
export const SESSION_DAYS = 30;
const LINK_CODE_MINUTES = 10;

export function setupCode(): string | undefined {
	return (
		(process.env.COUCH_SETUP_CODE ?? process.env.COUCH_AUTH_PASSWORD)?.trim() ||
		undefined
	);
}

export function authEnabled(): boolean {
	return Boolean(setupCode());
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Constant-time compare via fixed-length digests, so length leaks nothing. */
export function safeEqual(a: string, b: string): boolean {
	return timingSafeEqual(
		Buffer.from(sha256(a), "hex"),
		Buffer.from(sha256(b), "hex"),
	);
}

// ---------------------------------------------------------------- passkeys

export interface StoredPasskey {
	id: string;
	publicKey: Uint8Array;
	counter: number;
	transports: string[];
	name: string;
	backedUp: boolean;
	createdAt: string;
	lastUsedAt: string | null;
}

interface PasskeyRow {
	id: string;
	public_key: Uint8Array;
	counter: number;
	transports: string | null;
	name: string;
	backed_up: number;
	created_at: string;
	last_used_at: string | null;
}

const toPasskey = (r: PasskeyRow): StoredPasskey => ({
	id: r.id,
	publicKey: new Uint8Array(r.public_key),
	counter: r.counter,
	transports: r.transports ? (JSON.parse(r.transports) as string[]) : [],
	name: r.name,
	backedUp: Boolean(r.backed_up),
	createdAt: r.created_at,
	lastUsedAt: r.last_used_at,
});

export function listPasskeys(): StoredPasskey[] {
	return (
		getDb()
			.prepare("SELECT * FROM passkey ORDER BY created_at")
			.all() as unknown as PasskeyRow[]
	).map(toPasskey);
}

export function hasPasskeys(): boolean {
	return (
		(
			getDb().prepare("SELECT COUNT(*) AS n FROM passkey").get() as {
				n: number;
			}
		).n > 0
	);
}

export function getPasskey(id: string): StoredPasskey | null {
	const row = getDb().prepare("SELECT * FROM passkey WHERE id = ?").get(id) as
		| PasskeyRow
		| undefined;
	return row ? toPasskey(row) : null;
}

export function savePasskey(
	p: Omit<StoredPasskey, "createdAt" | "lastUsedAt">,
): void {
	getDb()
		.prepare(
			`INSERT INTO passkey (id, public_key, counter, transports, name, backed_up, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			p.id,
			p.publicKey,
			p.counter,
			JSON.stringify(p.transports),
			p.name,
			p.backedUp ? 1 : 0,
			new Date().toISOString(),
		);
}

export function markPasskeyUsed(id: string, counter: number): void {
	getDb()
		.prepare("UPDATE passkey SET counter = ?, last_used_at = ? WHERE id = ?")
		.run(counter, new Date().toISOString(), id);
}

export function removePasskey(id: string): void {
	getDb().prepare("DELETE FROM passkey WHERE id = ?").run(id);
}

/** Recovery: forget every passkey and session; the setup code works again. */
export function resetAuth(): { passkeys: number; sessions: number } {
	const db = getDb();
	const passkeys = Number(db.prepare("DELETE FROM passkey").run().changes);
	const sessions = Number(db.prepare("DELETE FROM session").run().changes);
	deleteSetting("auth.link_code");
	return { passkeys, sessions };
}

// ---------------------------------------------------------------- sessions

export function createSession(userAgent: string | null): {
	token: string;
	maxAge: number;
} {
	const token = randomBytes(32).toString("base64url");
	const now = new Date();
	const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
	getDb()
		.prepare(
			"INSERT INTO session (token_hash, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?)",
		)
		.run(
			sha256(token),
			now.toISOString(),
			expires.toISOString(),
			now.toISOString(),
			userAgent?.slice(0, 200) ?? null,
		);
	return { token, maxAge: SESSION_DAYS * 86_400 };
}

export function validSession(token: string | undefined): boolean {
	if (!token) return false;
	const db = getDb();
	const hash = sha256(token);
	const row = db
		.prepare(
			"SELECT expires_at, last_seen_at FROM session WHERE token_hash = ?",
		)
		.get(hash) as { expires_at: string; last_seen_at: string } | undefined;
	if (!row) return false;
	if (Date.parse(row.expires_at) < Date.now()) {
		db.prepare("DELETE FROM session WHERE token_hash = ?").run(hash);
		return false;
	}
	// Touch at most hourly; this runs on every request.
	if (Date.now() - Date.parse(row.last_seen_at) > 3_600_000) {
		db.prepare("UPDATE session SET last_seen_at = ? WHERE token_hash = ?").run(
			new Date().toISOString(),
			hash,
		);
	}
	return true;
}

export function endSession(token: string | undefined): void {
	if (token)
		getDb()
			.prepare("DELETE FROM session WHERE token_hash = ?")
			.run(sha256(token));
}

export function readCookie(
	header: string | null,
	name: string,
): string | undefined {
	for (const part of (header ?? "").split(";")) {
		const [k, ...v] = part.trim().split("=");
		if (k === name) return decodeURIComponent(v.join("="));
	}
	return undefined;
}

export function sessionCookie(
	token: string,
	maxAge: number,
	secure: boolean,
): string {
	return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function clearedCookie(secure: boolean): string {
	return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

// ------------------------------------------------- one-time device link code

/** A short code, made on a signed-in device, that lets another device add a passkey. */
export function createLinkCode(): { code: string; expiresAt: string } {
	// 8 chars from an unambiguous alphabet, shown as XXXX-XXXX.
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	const bytes = randomBytes(8);
	const raw = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
	const expiresAt = new Date(
		Date.now() + LINK_CODE_MINUTES * 60_000,
	).toISOString();
	setSetting("auth.link_code", { hash: sha256(raw), expiresAt });
	return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt };
}

/** Checks (without consuming) a link code. */
export function linkCodeValid(code: string): boolean {
	const stored = getSetting<{ hash: string; expiresAt: string }>(
		"auth.link_code",
	);
	if (!stored || Date.parse(stored.expiresAt) < Date.now()) return false;
	const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
	return timingSafeEqual(
		Buffer.from(sha256(normalized), "hex"),
		Buffer.from(stored.hash, "hex"),
	);
}

export function consumeLinkCode(): void {
	deleteSetting("auth.link_code");
}
