/**
 * Server functions: the web UI's whole API surface. They run on the server
 * only; the client calls them as typed functions.
 *
 * Read-only towards Simkl by design. Couch never writes to the user's
 * library; the only writes are local (feedback, notes, cached data).
 */

import { createServerFn } from "@tanstack/react-start";
import { config } from "./config.ts";
import { libraryStats, listShows, upNext } from "./library.ts";
import { createLogger } from "./log.ts";
import { latestPicks, runPicks, setFeedback } from "./picks.ts";
import {
	isLoggedIn,
	type LoginPoll,
	logout,
	pollLogin,
	type ShowStatus,
	simklConfigured,
	startLogin,
} from "./simkl.ts";
import { lastFullSync, syncAll } from "./sync.ts";
import { buildProfile, getNotes, getProfile, setNotes } from "./taste.ts";

const log = createLogger("web");

const STATUSES: ShowStatus[] = [
	"watching",
	"plantowatch",
	"hold",
	"completed",
	"dropped",
];

/** Turn thrown errors into a message the UI can show, and log them. */
async function guarded<T>(
	key: string,
	fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
	try {
		return { ok: true, value: await fn() };
	} catch (error) {
		log.error(key, undefined, error);
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

// ---------------------------------------------------------------- status

export const getStatus = createServerFn({ method: "GET" }).handler(
	async () => ({
		simklConfigured: simklConfigured(),
		simklConnected: simklConfigured() && isLoggedIn(),
		tmdbConfigured: Boolean(config.tmdbApiKey),
		openRouterConfigured: Boolean(config.openRouterApiKey),
		lastSync: lastFullSync(),
		stats: libraryStats(),
		services: config.services,
		country: config.countryCode,
	}),
);

// ----------------------------------------------------------------- simkl

export const beginSimklLogin = createServerFn({ method: "POST" }).handler(() =>
	guarded("SIMKL_LOGIN_START_FAILED", async () => {
		const l = await startLogin();
		return {
			userCode: l.userCode,
			verificationUrl: l.verificationUrl,
			interval: l.interval,
			expiresAt: l.expiresAt,
		};
	}),
);

export const checkSimklLogin = createServerFn({ method: "POST" }).handler(() =>
	guarded<LoginPoll>("SIMKL_LOGIN_POLL_FAILED", () => pollLogin()),
);

export const disconnectSimkl = createServerFn({ method: "POST" }).handler(
	async () => {
		logout();
		log.info("SIMKL_LOGOUT");
		return { ok: true };
	},
);

export const runSync = createServerFn({ method: "POST" })
	.validator((d: { force?: boolean } | undefined) => ({
		force: Boolean(d?.force),
	}))
	.handler(({ data }) => guarded("SYNC_FAILED", () => syncAll(data.force)));

// --------------------------------------------------------------- library

export const getUpNext = createServerFn({ method: "GET" }).handler(async () =>
	upNext(),
);

export const getLibrary = createServerFn({ method: "GET" })
	.validator((d: { status?: string } | undefined) => ({
		status: STATUSES.includes(d?.status as ShowStatus)
			? (d?.status as ShowStatus)
			: undefined,
	}))
	.handler(async ({ data }) => ({
		shows: listShows(data.status),
		stats: libraryStats(),
	}));

// ----------------------------------------------------------------- picks

export const getPicks = createServerFn({ method: "GET" }).handler(async () =>
	latestPicks(),
);

export const generatePicks = createServerFn({ method: "POST" }).handler(() =>
	guarded("PICKS_FAILED", () => runPicks()),
);

export const ratePick = createServerFn({ method: "POST" })
	.validator(
		(d: { runId: number; tmdbId: number; feedback: 1 | -1 | null }) => {
			if (!Number.isInteger(d?.runId) || !Number.isInteger(d?.tmdbId)) {
				throw new Error("runId and tmdbId are required");
			}
			if (![1, -1, null].includes(d.feedback)) throw new Error("bad feedback");
			return d;
		},
	)
	.handler(async ({ data }) => {
		setFeedback(data.runId, data.tmdbId, data.feedback);
		log.info("PICK_FEEDBACK", data);
		return { ok: true };
	});

// ----------------------------------------------------------------- taste

export const getTaste = createServerFn({ method: "GET" }).handler(async () => ({
	profile: getProfile(),
	notes: getNotes(),
}));

export const saveNotes = createServerFn({ method: "POST" })
	.validator((d: { notes: string }) => ({
		notes: String(d?.notes ?? "").slice(0, 4000),
	}))
	.handler(async ({ data }) => {
		setNotes(data.notes);
		return { ok: true };
	});

export const rebuildTaste = createServerFn({ method: "POST" }).handler(() =>
	guarded("PROFILE_FAILED", async () => (await buildProfile(true)).profile),
);
