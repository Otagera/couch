/**
 * Sign-in gate, run ahead of every route (pages, server functions, assets).
 *
 * Passkey sessions replace the comics-style basic auth: a valid session
 * cookie passes; otherwise pages redirect to /login and everything else gets
 * a 401. /login, /auth/* (the passkey ceremony) and static build assets are
 * always reachable.
 *
 * Env-gated like comics: with no COUCH_SETUP_CODE the app is open, which is
 * what a local `npm run dev` wants. Anything reachable from the internet
 * must set it.
 */

import { defineEventHandler } from "h3";
import {
	authEnabled,
	readCookie,
	SESSION_COOKIE,
	validSession,
} from "./auth/store.ts";

const OPEN_PREFIXES = ["/auth/", "/assets/"];
const OPEN_PATHS = new Set(["/login", "/favicon.ico", "/robots.txt"]);
// Vite's dev server serves modules from these; they never exist in production.
const DEV_PREFIXES = ["/@", "/src/", "/node_modules/", "/__"];

export default defineEventHandler((event) => {
	if (!authEnabled()) return;
	const req = event.req as Request;
	const url = new URL(req.url);
	const path = url.pathname;

	if (OPEN_PATHS.has(path) || OPEN_PREFIXES.some((p) => path.startsWith(p)))
		return;
	if (
		process.env.NODE_ENV !== "production" &&
		DEV_PREFIXES.some((p) => path.startsWith(p))
	)
		return;
	if (validSession(readCookie(req.headers.get("cookie"), SESSION_COOKIE)))
		return;

	const wantsPage =
		req.method === "GET" &&
		(req.headers.get("accept") ?? "").includes("text/html");
	if (wantsPage) {
		const next =
			path === "/" ? "" : `?next=${encodeURIComponent(path + url.search)}`;
		return new Response(null, {
			status: 302,
			headers: { Location: `/login${next}`, "Cache-Control": "no-store" },
		});
	}
	return new Response(JSON.stringify({ error: "Sign in required" }), {
		status: 401,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
		},
	});
});
