/**
 * A full refresh: pull the Simkl library, then refresh TMDB details for the
 * shows "up next" reasons about (air dates, posters, providers).
 */

import { getSetting, setSetting } from "./db/index.ts";
import { refreshLibraryDetails } from "./library.ts";
import { createLogger } from "./log.ts";
import { syncShows } from "./simkl.ts";

const log = createLogger("sync");

export interface FullSync {
	changed: boolean;
	shows: number;
	detailsRefreshed: number;
	finishedAt: string;
}

export async function syncAll(force = false): Promise<FullSync> {
	const started = Date.now();
	let simkl: Awaited<ReturnType<typeof syncShows>>;
	let detailsRefreshed: number;
	try {
		simkl = await syncShows(force);
		detailsRefreshed = await refreshLibraryDetails();
	} catch (error) {
		log.error("SYNC_FAILED", { force }, error);
		throw error;
	}
	const result: FullSync = {
		...simkl,
		detailsRefreshed,
		finishedAt: new Date().toISOString(),
	};
	setSetting("sync.last", result);
	log.info("SYNC_DONE", { ...result, ms: Date.now() - started });
	return result;
}

export function lastFullSync(): FullSync | null {
	return getSetting<FullSync>("sync.last");
}
