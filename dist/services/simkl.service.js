"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SimklService = exports.SimklError = void 0;
const axios_1 = __importStar(require("axios"));
const errors_1 = require("../errors");
const logger_1 = require("../logger");
const API_BASE = "https://api.simkl.com";
const APP_NAME = "my-movies-cli";
const APP_VERSION = "1.0";
const TOKENS_KEY = "simkl_tokens";
const SHOWS_KEY = "simkl_shows";
const ACTIVITY_KEY = "simkl_tv_activity";
class SimklError extends errors_1.AppError {
    constructor(message, context) {
        super(message, "SIMKL_ERROR", 503, true, context);
    }
}
exports.SimklError = SimklError;
class SimklService {
    clientId;
    cacheService;
    logger = (0, logger_1.createLogger)("SimklService");
    http;
    constructor(clientId, cacheService) {
        this.clientId = clientId;
        this.cacheService = cacheService;
        if (!clientId)
            throw new SimklError("SIMKL_CLIENT_ID is not set.");
        this.http = axios_1.default.create({
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
    async isLoggedIn() {
        return (await this.cacheService.get(TOKENS_KEY)) !== null;
    }
    async logout() {
        await this.cacheService.set(TOKENS_KEY, null);
    }
    /**
     * Device (PIN) flow: shows a code the user enters at simkl.com/pin, then
     * polls until they approve. Read-only scope is enough for syncing.
     */
    async login(onPrompt) {
        const { data } = await this.http.post("/oauth2/device", new URLSearchParams({ client_id: this.clientId, scope: "media:read" }));
        onPrompt({
            userCode: data.user_code,
            verificationUrl: data.verification_uri_complete ?? data.verification_uri,
        });
        let interval = (data.interval ?? 5) * 1000;
        const deadline = Date.now() + (data.expires_in ?? 900) * 1000;
        while (Date.now() < deadline) {
            await sleep(interval);
            try {
                const res = await this.http.post("/oauth2/token", new URLSearchParams({
                    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                    client_id: this.clientId,
                    device_code: data.device_code,
                }));
                await this.saveTokens(res.data);
                return;
            }
            catch (error) {
                const code = (0, axios_1.isAxiosError)(error) ? error.response?.data?.error : null;
                if (code === "authorization_pending")
                    continue;
                if (code === "slow_down") {
                    interval += 5000;
                    continue;
                }
                if (code === "expired_token")
                    break;
                throw new SimklError(`Simkl login failed: ${code ?? String(error)}`, {
                    description: (0, axios_1.isAxiosError)(error)
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
    async syncShows(force = false) {
        const activities = await this.get("/sync/activities");
        const tvActivity = activities.tv_shows?.all ?? null;
        const lastActivity = await this.cacheService.get(ACTIVITY_KEY);
        const cached = await this.getCachedShows();
        if (!force && cached.length > 0 && tvActivity === lastActivity) {
            return { shows: cached, changed: false };
        }
        // One call returns every show with ratings and progress. Fine below
        // Simkl's 20k-items-per-call limit, which a personal library won't hit.
        const data = await this.get("/sync/all-items/shows", { extended: "ids_only" });
        const shows = (data.shows ?? []).map(toShow);
        await this.cacheService.set(SHOWS_KEY, shows);
        await this.cacheService.set(ACTIVITY_KEY, tvActivity);
        return { shows, changed: true };
    }
    async getCachedShows() {
        return (await this.cacheService.get(SHOWS_KEY)) ?? [];
    }
    async get(path, params) {
        const token = await this.getAccessToken();
        try {
            const res = await this.http.get(path, {
                params,
                headers: { Authorization: `Bearer ${token}` },
            });
            return res.data;
        }
        catch (error) {
            if ((0, axios_1.isAxiosError)(error)) {
                const status = error.response?.status;
                const body = error.response?.data;
                if (status === 401) {
                    throw new SimklError("Simkl rejected the login token. Run the Simkl login again.", { path, body });
                }
                if (status === 429) {
                    throw new SimklError(body?.error === "user_limit_exceeded"
                        ? "Simkl daily request quota used up; it resets at midnight US Eastern."
                        : "Simkl rate limit hit; try again in a moment.", { path, body });
                }
                throw new SimklError(`Simkl API error ${status ?? ""} on ${path}`, {
                    path,
                    body,
                });
            }
            throw error;
        }
    }
    async getAccessToken() {
        const tokens = await this.cacheService.get(TOKENS_KEY);
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
            const res = await this.http.post("/oauth2/token", new URLSearchParams({
                grant_type: "refresh_token",
                client_id: this.clientId,
                refresh_token: tokens.refreshToken,
            }));
            return (await this.saveTokens(res.data)).accessToken;
        }
        catch (error) {
            throw new SimklError("Simkl session expired. Run the Simkl login again.", {
                error: (0, axios_1.isAxiosError)(error) ? error.response?.data : String(error),
            });
        }
    }
    async saveTokens(res) {
        const tokens = {
            accessToken: res.access_token,
            refreshToken: res.refresh_token,
            expiresAt: Date.now() + res.expires_in * 1000,
            scope: res.scope,
        };
        await this.cacheService.set(TOKENS_KEY, tokens);
        return tokens;
    }
}
exports.SimklService = SimklService;
function toShow(raw) {
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
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
