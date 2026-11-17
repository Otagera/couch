/**
 * Simkl: the source of truth for what TV the user watches.
 *
 * Login is the device (PIN) flow, which needs no client secret and no
 * redirect server: the right fit for both the CLI and a server with no
 * public OAuth callback. The app must be registered as "TV / devices / CLI".
 *
 * Free accounts get 500 API calls a day, so a sync asks /sync/activities
 * first and only downloads the library when the TV timestamp has moved.
 */

import { config, requireConfig } from "./config.ts";
import { deleteSetting, getDb, getSetting, setSetting } from "./db/index.ts";
import { createLogger } from "./log.ts";

const log = createLogger("simkl");

const API = "https://api.simkl.com";
const APP_NAME = "couch";
const APP_VERSION = "1.0";

const TOKENS = "simkl.tokens";
const TV_ACTIVITY = "simkl.tv_activity";
const LAST_SYNC = "simkl.last_sync";
const PENDING_LOGIN = "simkl.pending_login";

export type ShowStatus =
	| "watching"
	| "plantowatch"
	| "hold"
	| "completed"
	| "dropped";

interface Tokens {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	scope: string;
}

interface TokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	scope: string;
}

interface RawShow {
	status: ShowStatus;
	user_rating: number | null;
	user_rated_at: string | null;
	added_to_watchlist_at: string | null;
	last_watched_at: string | null;
	last_watched: string | null;
	next_to_watch: string | null;
	watched_episodes_count: number | null;
	total_episodes_count: number | null;
	not_aired_episodes_count: number | null;
	show: {
		title: string;
		year: number | null;
		ids: {
			simkl: number;
			slug: string;
			tmdb?: string;
			imdb?: string;
			tvdb?: string;
		};
	};
}

export class SimklError extends Error {}

function url(path: string, params: Record<string, string> = {}): string {
	const u = new URL(path, API);
	u.searchParams.set(
		"client_id",
		requireConfig("simklClientId", "SIMKL_CLIENT_ID"),
	);
	u.searchParams.set("app-name", APP_NAME);
	u.searchParams.set("app-version", APP_VERSION);
	for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
	return u.toString();
}

const baseHeaders = { "User-Agent": `${APP_NAME}/${APP_VERSION}` };

async function postForm(
	path: string,
	body: Record<string, string>,
): Promise<{ status: number; data: Record<string, unknown> }> {
	const res = await fetch(url(path), {
		method: "POST",
		headers: {
			...baseHeaders,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(body),
	});
	const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	return { status: res.status, data };
}

// ------------------------------------------------------------------ login

export interface DeviceLogin {
	userCode: string;
	verificationUrl: string;
	expiresAt: number;
	interval: number;
}

/** Step 1: ask Simkl for a code the user types in at simkl.com/pin. */
export async function startLogin(): Promise<DeviceLogin> {
	const clientId = requireConfig("simklClientId", "SIMKL_CLIENT_ID");
	const { status, data } = await postForm("/oauth2/device", {
		client_id: clientId,
		scope: "media:read",
	});
	if (status >= 400 || typeof data.device_code !== "string") {
		throw new SimklError(
			`Simkl refused the login request (${status}: ${data.error ?? "unknown"}).`,
		);
	}
	const login: DeviceLogin = {
		userCode: String(data.user_code),
		verificationUrl: String(
			data.verification_uri_complete ?? data.verification_uri,
		),
		expiresAt: Date.now() + Number(data.expires_in ?? 900) * 1000,
		interval: Number(data.interval ?? 5),
	};
	// The device code is a secret: it stays server-side, never in a response.
	setSetting(PENDING_LOGIN, { ...login, deviceCode: data.device_code });
	return login;
}

export type LoginPoll = "pending" | "slow_down" | "done" | "expired";

/** Step 2: one poll. Callers wait `interval` seconds between polls. */
export async function pollLogin(): Promise<LoginPoll> {
	const pending = getSetting<DeviceLogin & { deviceCode: string }>(
		PENDING_LOGIN,
	);
	if (!pending || Date.now() > pending.expiresAt) {
		deleteSetting(PENDING_LOGIN);
		return "expired";
	}
	const { status, data } = await postForm("/oauth2/token", {
		grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		client_id: requireConfig("simklClientId", "SIMKL_CLIENT_ID"),
		device_code: pending.deviceCode,
	});
	if (status < 400 && typeof data.access_token === "string") {
		saveTokens(data as unknown as TokenResponse);
		log.info("SIMKL_LOGIN_OK", { scope: data.scope });
		deleteSetting(PENDING_LOGIN);
		return "done";
	}
	switch (data.error) {
		case "authorization_pending":
			return "pending";
		case "slow_down":
			return "slow_down";
		case "expired_token":
			deleteSetting(PENDING_LOGIN);
			return "expired";
		default:
			deleteSetting(PENDING_LOGIN);
			throw new SimklError(
				`Simkl login failed: ${data.error ?? status}${data.error_description ? ` (${data.error_description})` : ""}`,
			);
	}
}

/** Convenience for the CLI: start, then poll until approved or expired. */
export async function login(onCode: (l: DeviceLogin) => void): Promise<void> {
	const l = await startLogin();
	onCode(l);
	let wait = l.interval * 1000;
	for (;;) {
		await new Promise((r) => setTimeout(r, wait));
		const result = await pollLogin();
		if (result === "done") return;
		if (result === "expired")
			throw new SimklError("The Simkl code expired. Try again.");
		if (result === "slow_down") wait += 5000;
	}
}

export function isLoggedIn(): boolean {
	return getSetting<Tokens>(TOKENS) !== null;
}

export function logout(): void {
	deleteSetting(TOKENS);
	deleteSetting(TV_ACTIVITY);
}

function saveTokens(res: TokenResponse): Tokens {
	const tokens: Tokens = {
		accessToken: res.access_token,
		refreshToken: res.refresh_token,
		expiresAt: Date.now() + res.expires_in * 1000,
		scope: res.scope,
	};
	setSetting(TOKENS, tokens);
	return tokens;
}

async function accessToken(): Promise<string> {
	const tokens = getSetting<Tokens>(TOKENS);
	if (!tokens) throw new SimklError("Not connected to Simkl yet.");
	// Refresh a day early. The refresh token lasts 180 days and does not
	// rotate; each use slides its window forward.
	if (Date.now() < tokens.expiresAt - 86_400_000) return tokens.accessToken;
	const { status, data } = await postForm("/oauth2/token", {
		grant_type: "refresh_token",
		client_id: requireConfig("simklClientId", "SIMKL_CLIENT_ID"),
		refresh_token: tokens.refreshToken,
	});
	if (status >= 400 || typeof data.access_token !== "string") {
		throw new SimklError("The Simkl session expired. Connect again.");
	}
	return saveTokens(data as unknown as TokenResponse).accessToken;
}

async function get<T>(
	path: string,
	params?: Record<string, string>,
): Promise<T> {
	const res = await fetch(url(path, params), {
		headers: { ...baseHeaders, Authorization: `Bearer ${await accessToken()}` },
	});
	if (res.ok) return (await res.json()) as T;
	const body = (await res.json().catch(() => ({}))) as { error?: string };
	if (res.status === 401)
		throw new SimklError("Simkl rejected the login. Connect again.");
	if (res.status === 429) {
		throw new SimklError(
			body.error === "user_limit_exceeded"
				? "Simkl's daily request quota is used up; it resets at midnight US Eastern."
				: "Simkl rate limit hit; try again in a moment.",
		);
	}
	throw new SimklError(
		`Simkl API error ${res.status} on ${path}${body.error ? `: ${body.error}` : ""}`,
	);
}

// ------------------------------------------------------------------- sync

export interface SyncResult {
	changed: boolean;
	shows: number;
}

export async function syncShows(force = false): Promise<SyncResult> {
	const activities = await get<{ tv_shows?: { all: string | null } }>(
		"/sync/activities",
	);
	const tvActivity = activities.tv_shows?.all ?? null;
	const db = getDb();
	const count = () =>
		(db.prepare("SELECT COUNT(*) AS n FROM show").get() as { n: number }).n;

	if (!force && count() > 0 && tvActivity === getSetting<string>(TV_ACTIVITY)) {
		setSetting(LAST_SYNC, new Date().toISOString());
		return { changed: false, shows: count() };
	}

	// One call returns the whole TV library with ratings and progress; a
	// personal library is far below Simkl's 20k-items-per-call cap.
	const data = await get<{ shows?: RawShow[] }>("/sync/all-items/shows", {
		extended: "ids_only",
	});
	replaceShows(data.shows ?? []);
	setSetting(TV_ACTIVITY, tvActivity);
	setSetting(LAST_SYNC, new Date().toISOString());
	return { changed: true, shows: count() };
}

/** Replace the library wholesale: a full fetch also captures removals. */
export function replaceShows(raw: RawShow[]): void {
	const db = getDb();
	const now = new Date().toISOString();
	const insert = db.prepare(`INSERT INTO show (
		simkl_id, slug, title, year, tmdb_id, imdb_id, tvdb_id, status, user_rating,
		rated_at, added_at, last_watched_at, last_watched, next_to_watch,
		watched_episodes, total_episodes, not_aired, synced_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	db.exec("BEGIN");
	try {
		db.exec("DELETE FROM show");
		for (const r of raw) {
			const ids = r.show.ids;
			insert.run(
				ids.simkl,
				ids.slug,
				r.show.title,
				r.show.year ?? null,
				ids.tmdb ? Number(ids.tmdb) : null,
				ids.imdb ?? null,
				ids.tvdb ?? null,
				r.status,
				r.user_rating ?? null,
				r.user_rated_at ?? null,
				r.added_to_watchlist_at ?? null,
				r.last_watched_at ?? null,
				r.last_watched ?? null,
				r.next_to_watch ?? null,
				r.watched_episodes_count ?? 0,
				r.total_episodes_count ?? 0,
				r.not_aired_episodes_count ?? 0,
				now,
			);
		}
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

export function lastSync(): string | null {
	return getSetting<string>(LAST_SYNC);
}

export function simklConfigured(): boolean {
	return Boolean(config.simklClientId);
}

/** Simkl's attribution rule: every show links back to its Simkl page. */
export function simklUrl(simklId: number, slug: string): string {
	return `https://simkl.com/tv/${simklId}/${slug}`;
}
