import axios, { type AxiosInstance, isAxiosError } from "axios";
import { AppError } from "../errors";
import { createLogger } from "../logger";
import type { CacheService } from "./cache.service";

const API_BASE = "https://api.simkl.com";
const APP_NAME = "my-movies-cli";
const APP_VERSION = "1.0";

const TOKENS_KEY = "simkl_tokens";
const SHOWS_KEY = "simkl_shows";
const ACTIVITY_KEY = "simkl_tv_activity";

export type SimklShowStatus =
	| "watching"
	| "plantowatch"
	| "hold"
	| "completed"
	| "dropped";

export interface SimklShow {
	simklId: number;
	slug: string;
	title: string;
	year: number | null;
	tmdbId: number | null;
	imdbId: string | null;
	tvdbId: string | null;
	status: SimklShowStatus;
	userRating: number | null; // 1-10
	ratedAt: string | null;
	addedAt: string | null;
	lastWatchedAt: string | null;
	lastWatched: string | null; // e.g. "S05E16"
	nextToWatch: string | null;
	watchedEpisodes: number;
	totalEpisodes: number;
	notAiredEpisodes: number;
	/** Link required by Simkl's attribution rules wherever the show is displayed. */
	url: string;
}

interface StoredTokens {
	accessToken: string;
	refreshToken: string;
	expiresAt: number; // epoch ms
	scope: string;
}

interface TokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	scope: string;
}

interface RawAllItemsShow {
	status: SimklShowStatus;
	user_rating: number | null;
	user_rated_at: string | null;
	added_to_watchlist_at: string | null;
	last_watched_at: string | null;
	last_watched: string | null;
	next_to_watch: string | null;
	watched_episodes_count: number;
	total_episodes_count: number;
	not_aired_episodes_count: number;
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

export class SimklError extends AppError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, "SIMKL_ERROR", 503, true, context);
	}
}

export interface DeviceCodePrompt {
	userCode: string;
	verificationUrl: string;
}

export class SimklService {
	private logger = createLogger("SimklService");
	private http: AxiosInstance;

	constructor(
		private clientId: string,
		private cacheService: CacheService,
	) {
		if (!clientId) throw new SimklError("SIMKL_CLIENT_ID is not set.");
		this.http = axios.create({
			baseURL: API_BASE,
			timeout: 15000,
			headers: { "User-Agent": `${APP_NAME}/${APP_VERSION}` },
			params: {
				client_id: clientId,
				"app-name": APP_NAME,
				"app-version": APP_VERSION,
			},
		});
	}

	async isLoggedIn(): Promise<boolean> {
		return (await this.cacheService.get<StoredTokens>(TOKENS_KEY)) !== null;
	}

	async logout(): Promise<void> {
		await this.cacheService.set(TOKENS_KEY, null);
	}

	/**
	 * Device (PIN) flow: shows a code the user enters at simkl.com/pin, then
	 * polls until they approve. Read-only scope is enough for syncing.
	 */
	async login(onPrompt: (prompt: DeviceCodePrompt) => void): Promise<void> {
		const { data } = await this.http.post(
			"/oauth2/device",
			new URLSearchParams({ client_id: this.clientId, scope: "media:read" }),
		);

		onPrompt({
			userCode: data.user_code,
			verificationUrl: data.verification_uri_complete ?? data.verification_uri,
		});

		let interval = (data.interval ?? 5) * 1000;
		const deadline = Date.now() + (data.expires_in ?? 900) * 1000;

		while (Date.now() < deadline) {
			await sleep(interval);
			try {
				const res = await this.http.post<TokenResponse>(
					"/oauth2/token",
					new URLSearchParams({
						grant_type: "urn:ietf:params:oauth:grant-type:device_code",
						client_id: this.clientId,
						device_code: data.device_code,
					}),
				);
				await this.saveTokens(res.data);
				return;
			} catch (error) {
				const code = isAxiosError(error) ? error.response?.data?.error : null;
				if (code === "authorization_pending") continue;
				if (code === "slow_down") {
					interval += 5000;
					continue;
				}
				if (code === "expired_token") break;
				throw new SimklError(`Simkl login failed: ${code ?? String(error)}`, {
					description: isAxiosError(error)
						? error.response?.data?.error_description
						: undefined,
				});
			}
		}
		throw new SimklError("Simkl login timed out. Run login again.");
	}

	/**
	 * Pulls the user's TV shows. Skips the download when Simkl's activity
	 * timestamps say nothing changed since the last sync (saves daily quota).
	 */
	async syncShows(
		force = false,
	): Promise<{ shows: SimklShow[]; changed: boolean }> {
		const activities = await this.get<{
			tv_shows?: { all: string | null };
		}>("/sync/activities");
		const tvActivity = activities.tv_shows?.all ?? null;
		const lastActivity = await this.cacheService.get<string>(ACTIVITY_KEY);
		const cached = await this.getCachedShows();

		if (!force && cached.length > 0 && tvActivity === lastActivity) {
			return { shows: cached, changed: false };
		}

		// One call returns every show with ratings and progress. Fine below
		// Simkl's 20k-items-per-call limit, which a personal library won't hit.
		const data = await this.get<{ shows?: RawAllItemsShow[] }>(
			"/sync/all-items/shows",
			{ extended: "ids_only" },
		);
		const shows = (data.shows ?? []).map(toShow);

		await this.cacheService.set(SHOWS_KEY, shows);
		await this.cacheService.set(ACTIVITY_KEY, tvActivity);
		return { shows, changed: true };
	}

	async getCachedShows(): Promise<SimklShow[]> {
		return (await this.cacheService.get<SimklShow[]>(SHOWS_KEY)) ?? [];
	}

	private async get<T>(
		path: string,
		params?: Record<string, string>,
	): Promise<T> {
		const token = await this.getAccessToken();
		try {
			const res = await this.http.get<T>(path, {
				params,
				headers: { Authorization: `Bearer ${token}` },
			});
			return res.data;
		} catch (error) {
			if (isAxiosError(error)) {
				const status = error.response?.status;
				const body = error.response?.data;
				if (status === 401) {
					throw new SimklError(
						"Simkl rejected the login token. Run the Simkl login again.",
						{ path, body },
					);
				}
				if (status === 429) {
					throw new SimklError(
						body?.error === "user_limit_exceeded"
							? "Simkl daily request quota used up; it resets at midnight US Eastern."
							: "Simkl rate limit hit; try again in a moment.",
						{ path, body },
					);
				}
				throw new SimklError(`Simkl API error ${status ?? ""} on ${path}`, {
					path,
					body,
				});
			}
			throw error;
		}
	}

	private async getAccessToken(): Promise<string> {
		const tokens = await this.cacheService.get<StoredTokens>(TOKENS_KEY);
		if (!tokens) {
			throw new SimklError("Not logged in to Simkl. Run the Simkl login.");
		}
		// Refresh a day early. The refresh token itself lasts 180 days and slides
		// forward on each use.
		if (Date.now() < tokens.expiresAt - 24 * 3600 * 1000) {
			return tokens.accessToken;
		}
		this.logger.debug("Refreshing Simkl access token");
		try {
			const res = await this.http.post<TokenResponse>(
				"/oauth2/token",
				new URLSearchParams({
					grant_type: "refresh_token",
					client_id: this.clientId,
					refresh_token: tokens.refreshToken,
				}),
			);
			return (await this.saveTokens(res.data)).accessToken;
		} catch (error) {
			throw new SimklError(
				"Simkl session expired. Run the Simkl login again.",
				{
					error: isAxiosError(error) ? error.response?.data : String(error),
				},
			);
		}
	}

	private async saveTokens(res: TokenResponse): Promise<StoredTokens> {
		const tokens: StoredTokens = {
			accessToken: res.access_token,
			refreshToken: res.refresh_token,
			expiresAt: Date.now() + res.expires_in * 1000,
			scope: res.scope,
		};
		await this.cacheService.set(TOKENS_KEY, tokens);
		return tokens;
	}
}

function toShow(raw: RawAllItemsShow): SimklShow {
	const ids = raw.show.ids;
	return {
		simklId: ids.simkl,
		slug: ids.slug,
		title: raw.show.title,
		year: raw.show.year ?? null,
		tmdbId: ids.tmdb ? Number(ids.tmdb) : null,
		imdbId: ids.imdb ?? null,
		tvdbId: ids.tvdb ?? null,
		status: raw.status,
		userRating: raw.user_rating,
		ratedAt: raw.user_rated_at,
		addedAt: raw.added_to_watchlist_at,
		lastWatchedAt: raw.last_watched_at,
		lastWatched: raw.last_watched,
		nextToWatch: raw.next_to_watch,
		watchedEpisodes: raw.watched_episodes_count ?? 0,
		totalEpisodes: raw.total_episodes_count ?? 0,
		notAiredEpisodes: raw.not_aired_episodes_count ?? 0,
		url: `https://simkl.com/tv/${ids.simkl}/${ids.slug}`,
	};
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
