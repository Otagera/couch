/**
 * A full refresh. TV and films are independent: either source failing (or
 * not being set up) never stops the other.
 *
 *   TV:    Simkl library, then TMDB details for shows "up next" reasons about.
 *   Films: Letterboxd CSV export (when the files changed), the diary RSS
 *          feed, TMDB ids for new films, then providers for the watchlist.
 *   Lists: followed Letterboxd lists, each re-read at most once a day.
 */

import { config } from "./config.ts";
import { getSetting, setSetting } from "./db/index.ts";
import {
	importLetterboxdCsv,
	refreshWatchedDetails,
	refreshWatchlistDetails,
	resolveTmdbIds,
	syncLetterboxdRss,
} from "./films.ts";
import { refreshLibraryDetails } from "./library.ts";
import { importExportedLists, refreshDueLists } from "./lists.ts";
import { createLogger } from "./log.ts";
import { isLoggedIn, simklConfigured, syncShows } from "./simkl.ts";

const log = createLogger("sync");

export interface FullSync {
	tv: { changed: boolean; shows: number; detailsRefreshed: number } | null;
	films: {
		csvImported: boolean;
		rssEntries: number;
		matched: number;
		films: number;
	} | null;
	lists: { added: number; refreshed: number; failed: number } | null;
	errors: string[];
	finishedAt: string;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function syncAll(force = false): Promise<FullSync> {
	const started = Date.now();
	const errors: string[] = [];

	let tv: FullSync["tv"] = null;
	if (simklConfigured() && isLoggedIn()) {
		try {
			const simkl = await syncShows(force);
			tv = { ...simkl, detailsRefreshed: await refreshLibraryDetails() };
		} catch (error) {
			log.error("SYNC_TV_FAILED", { force }, error);
			errors.push(`TV: ${message(error)}`);
		}
	}

	let films: FullSync["films"] = null;
	try {
		const csv = importLetterboxdCsv(force);
		let rssEntries = 0;
		if (config.letterboxdUsername) {
			try {
				rssEntries = (await syncLetterboxdRss()).entries;
			} catch (error) {
				log.warn("SYNC_RSS_FAILED", undefined, error);
				errors.push(`Letterboxd RSS: ${message(error)}`);
			}
		}
		const { matched } = await resolveTmdbIds();
		await refreshWatchlistDetails();
		await refreshWatchedDetails();
		films = {
			csvImported: csv.imported,
			rssEntries,
			matched,
			films: csv.films,
		};
	} catch (error) {
		log.error("SYNC_FILMS_FAILED", { force }, error);
		errors.push(`Films: ${message(error)}`);
	}

	// Lists come after films so list items can reuse film TMDB matches.
	let lists: FullSync["lists"] = null;
	try {
		const added = await importExportedLists();
		lists = { added, ...(await refreshDueLists(force)) };
		if (lists.failed) errors.push(`Lists: ${lists.failed} could not be read`);
	} catch (error) {
		log.error("SYNC_LISTS_FAILED", undefined, error);
		errors.push(`Lists: ${message(error)}`);
	}

	const result: FullSync = {
		tv,
		films,
		lists,
		errors,
		finishedAt: new Date().toISOString(),
	};
	setSetting("sync.last", result);
	log.info(errors.length ? "SYNC_PARTIAL" : "SYNC_DONE", {
		...result,
		ms: Date.now() - started,
	});
	if (!tv && !films) throw new Error(errors.join("; ") || "Nothing to sync.");
	return result;
}

export function lastFullSync(): FullSync | null {
	return getSetting<FullSync>("sync.last");
}
