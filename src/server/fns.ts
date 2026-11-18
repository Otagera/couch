/**
 * Server functions: the web UI's whole API surface. They run on the server
 * only; the client calls them as typed functions.
 *
 * Read-only towards Simkl by design. Couch never writes to the user's
 * library; the only writes are local (feedback, notes, cached data).
 */

import { createServerFn } from "@tanstack/react-start";
import { authEnabled } from "./auth/store.ts";
import { config } from "./config.ts";
import { getSetting } from "./db/index.ts";
import { filmStats } from "./films.ts";
import { getHome as buildHome } from "./home.ts";
import { libraryStats } from "./library.ts";
import {
	type KindFilter,
	libraryView,
	SHELVES,
	type Shelf,
} from "./libraryView.ts";
import {
	canonicalListUrl,
	followList,
	listItems,
	listProgress,
	pinList,
	refreshList,
	unfollowList,
} from "./lists.ts";
import { createLogger } from "./log.ts";
import { latestPicks, type MediaKind, runPicks, setFeedback } from "./picks.ts";
import {
	isLoggedIn,
	type LoginPoll,
	logout,
	pollLogin,
	simklConfigured,
	startLogin,
} from "./simkl.ts";
import { lastFullSync, syncAll } from "./sync.ts";
import { buildProfile, getNotes, getProfile, setNotes } from "./taste.ts";
import { posterUrl } from "./tmdb.ts";
import { getMovies } from "./tmdbMovies.ts";

const log = createLogger("web");

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
		authEnabled: authEnabled(),
		simklConfigured: simklConfigured(),
		simklConnected: simklConfigured() && isLoggedIn(),
		tmdbConfigured: Boolean(config.tmdbApiKey),
		openRouterConfigured: Boolean(config.openRouterApiKey),
		lastSync: lastFullSync(),
		stats: libraryStats(),
		films: filmStats(),
		letterboxdRss: Boolean(config.letterboxdUsername),
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

export const getHome = createServerFn({ method: "GET" }).handler(() =>
	buildHome(),
);

export const getLibrary = createServerFn({ method: "GET" })
	.validator((d: { shelf?: string; kind?: string } | undefined) => ({
		shelf: (SHELVES.includes(d?.shelf as Shelf) ? d?.shelf : "all") as Shelf,
		kind: (["tv", "film"].includes(d?.kind ?? "")
			? d?.kind
			: "all") as KindFilter,
	}))
	.handler(async ({ data }) => libraryView(data.shelf, data.kind));

// ----------------------------------------------------------------- picks

const kindOf = (d: { kind?: string } | undefined): { kind: MediaKind } => ({
	kind: d?.kind === "movie" ? "movie" : "tv",
});

export const getPicks = createServerFn({ method: "GET" })
	.validator(kindOf)
	.handler(async ({ data }) => latestPicks(data.kind));

/** Both kinds at once, for the default "All" view. */
export const getAllPicks = createServerFn({ method: "GET" }).handler(
	async () => ({
		tv: latestPicks("tv"),
		movie: latestPicks("movie"),
	}),
);

export const generatePicks = createServerFn({ method: "POST" })
	.validator(kindOf)
	.handler(({ data }) => guarded("PICKS_FAILED", () => runPicks(data.kind)));

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
	films: filmStats(),
	letterboxdImportedAt: getSetting<string>("letterboxd.imported_at"),
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

// ----------------------------------------------------------------- lists

export const getLists = createServerFn({ method: "GET" }).handler(async () =>
	listProgress(),
);

export const getListDetail = createServerFn({ method: "GET" })
	.validator((d: { id: number }) => ({ id: Number(d?.id) }))
	.handler(async ({ data }) => {
		const list = listProgress().find((l) => l.id === data.id) ?? null;
		const items = list ? listItems(data.id) : [];
		// Posters for the visible list; details are cached for a week.
		const movies = await getMovies(
			items.slice(0, 300).flatMap((i) => (i.tmdbId ? [i.tmdbId] : [])),
		);
		return {
			list,
			items: items.map((i) => ({
				...i,
				poster: posterUrl(
					(i.tmdbId && movies.get(i.tmdbId)?.poster) || null,
					"w185",
				),
			})),
		};
	});

export const addList = createServerFn({ method: "POST" })
	.validator((d: { url: string }) => ({
		url: String(d?.url ?? "").slice(0, 500),
	}))
	.handler(({ data }) =>
		guarded("LIST_ADD_FAILED", async () => {
			const id = followList(await canonicalListUrl(data.url), "added");
			await refreshList(id);
			return { id };
		}),
	);

export const reloadList = createServerFn({ method: "POST" })
	.validator((d: { id: number }) => ({ id: Number(d?.id) }))
	.handler(({ data }) =>
		guarded("LIST_REFRESH_FAILED", () => refreshList(data.id)),
	);

export const setListPinned = createServerFn({ method: "POST" })
	.validator((d: { id: number; pinned: boolean }) => ({
		id: Number(d?.id),
		pinned: Boolean(d?.pinned),
	}))
	.handler(async ({ data }) => {
		pinList(data.id, data.pinned);
		return { ok: true };
	});

export const removeList = createServerFn({ method: "POST" })
	.validator((d: { id: number }) => ({ id: Number(d?.id) }))
	.handler(async ({ data }) => {
		unfollowList(data.id);
		return { ok: true };
	});
