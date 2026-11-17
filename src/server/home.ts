/**
 * The home page, organised by what you'd do next rather than by medium.
 * TV and films sit side by side in each section:
 *
 *   Up next        shows in progress + the next film in lists you're working through
 *   Ready tonight  new episodes of shows you follow + watchlist films on your services
 *   Your lists     progress through lists you've started
 *   Coming soon / Paused / On a long break   (TV)
 */

import { config } from "./config.ts";
import { watchlistStreaming } from "./films.ts";
import { type LibraryShow, upNext } from "./library.ts";
import { type ListProgress, listProgress } from "./lists.ts";
import { posterUrl } from "./tmdb.ts";
import { getMovies } from "./tmdbMovies.ts";

export interface HomeItem {
	kind: "tv" | "film";
	key: string;
	title: string;
	/** The action line: "Next S04E09", "MCU · 13 of 65", "6 new". */
	meta: string;
	detail: string;
	poster: string | null;
	url: string;
	/** 0-1, drawn as the sea line under the poster. */
	progress?: number;
	/** For mixing TV and films in one row: most recent activity first. */
	activeAt: string | null;
}

/** A list counts as "in progress" if you watched something from it recently. */
const ACTIVE_LIST_DAYS = 60;

const showItem = (s: LibraryShow, meta: string, detail: string): HomeItem => ({
	kind: "tv",
	key: `tv-${s.simklId}`,
	title: s.title,
	meta,
	detail,
	poster: s.poster,
	url: s.simklUrl,
	progress: s.aired ? s.watched / s.aired : undefined,
	activeAt: s.lastWatchedAt,
});

const byActivity = (a: HomeItem, b: HomeItem) =>
	(b.activeAt ?? "").localeCompare(a.activeAt ?? "");

export async function getHome() {
	const tv = upNext();
	const lists = listProgress();
	const activeSince = new Date(Date.now() - ACTIVE_LIST_DAYS * 86_400_000)
		.toISOString()
		.slice(0, 10);

	// Lists you're actively working through, one "next film" each. A film that
	// is next in two lists shows once, under the list touched most recently.
	const activeLists = lists.filter(
		(l) =>
			l.next &&
			l.watched > 0 &&
			l.lastWatchedAt &&
			l.lastWatchedAt >= activeSince,
	);
	const nextIds = activeLists
		.map((l) => l.next?.tmdbId)
		.filter((id): id is number => Boolean(id));
	const movies = await getMovies(nextIds);
	const seenFilms = new Set<number | string>();
	const listItems: HomeItem[] = [];
	for (const l of activeLists) {
		const n = l.next;
		if (!n) continue;
		const id = n.tmdbId ?? `${n.name}|${n.year}`;
		if (seenFilms.has(id)) continue;
		seenFilms.add(id);
		const m = n.tmdbId ? movies.get(n.tmdbId) : undefined;
		listItems.push({
			kind: "film",
			key: `list-${l.id}`,
			title: n.name,
			meta: `${l.name} · ${n.position} of ${l.total}`,
			detail: [
				n.year,
				m?.runtime ? `${m.runtime} min` : null,
				m?.providers.find((p) => config.services.includes(p.toLowerCase())),
			]
				.filter(Boolean)
				.join(" · "),
			poster: posterUrl(m?.poster ?? null),
			url: n.tmdbId ? `https://www.themoviedb.org/movie/${n.tmdbId}` : l.url,
			progress: l.total ? l.watched / l.total : undefined,
			activeAt: l.lastWatchedAt,
		});
	}

	const upNextItems = [
		...tv.continueWatching.map((s) =>
			showItem(
				s,
				`Next ${s.nextToWatch ?? "episode"}`,
				`${s.watched}/${s.aired} episodes`,
			),
		),
		...listItems,
	].sort(byActivity);

	const films = watchlistStreaming().filter((f) => !seenFilms.has(f.tmdbId));
	const readyTonight: HomeItem[] = [
		...tv.newEpisodes.map((s) =>
			showItem(
				s,
				`${s.behind} new episode${s.behind === 1 ? "" : "s"}`,
				s.status === "hold" ? "On hold" : "Was completed",
			),
		),
		...films.map(
			(f): HomeItem => ({
				kind: "film",
				key: `wl-${f.tmdbId}`,
				title: f.title,
				meta:
					f.providers
						.filter((p) => config.services.includes(p.toLowerCase()))
						.join(", ") || f.providers[0],
				detail: [
					f.year,
					f.runtime ? `${f.runtime} min` : null,
					"On your watchlist",
				]
					.filter(Boolean)
					.join(" · "),
				poster: f.poster,
				url: f.url,
				activeAt: null,
			}),
		),
	];

	return {
		upNext: upNextItems,
		readyTonight,
		lists: lists
			.filter((l) => l.watched > 0 && l.next)
			.slice(0, 8) satisfies ListProgress[],
		comingSoon: tv.comingSoon,
		paused: tv.paused,
		longBreak: tv.longBreak,
	};
}

export type Home = Awaited<ReturnType<typeof getHome>>;
