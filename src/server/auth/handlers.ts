/**
 * Passkey (WebAuthn) endpoints under /auth/*, registered as a Nitro handler.
 *
 *   GET  /auth/status                  { enabled, hasPasskeys, signedIn }
 *   POST /auth/register/options        { setupCode? | linkCode? }   (or signed in)
 *   POST /auth/register/verify         { response, name? }
 *   POST /auth/login/options
 *   POST /auth/login/verify            { response }
 *   POST /auth/logout
 *   GET  /auth/passkeys                                         (signed in)
 *   POST /auth/passkeys/remove         { id }                   (signed in)
 *   POST /auth/link-code                                        (signed in)
 *
 * Who may register a passkey: a signed-in browser (adding another), anyone
 * with the setup code while no passkey exists yet (first run, or after
 * `cli passkeys reset`), or anyone with a fresh one-time link code made on a
 * signed-in device. Wrong codes are throttled.
 */

// Must load before @simplewebauthn/server: its X.509 dependency (tsyringe)
// requires the Reflect metadata polyfill at import time.
import "reflect-metadata";
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { defineEventHandler } from "h3";
import { deleteSetting, getSetting, setSetting } from "../db/index.ts";
import { createLogger } from "../log.ts";
import {
	authEnabled,
	clearedCookie,
	consumeLinkCode,
	createLinkCode,
	createSession,
	endSession,
	getPasskey,
	hasPasskeys,
	linkCodeValid,
	listPasskeys,
	markPasskeyUsed,
	readCookie,
	removePasskey,
	SESSION_COOKIE,
	safeEqual,
	savePasskey,
	sessionCookie,
	setupCode,
	validSession,
} from "./store.ts";

const log = createLogger("auth");
const CHALLENGE = "auth.challenge";
const CHALLENGE_MS = 5 * 60_000;

// ------------------------------------------------------------- throttling

const failures: number[] = [];
function throttled(): boolean {
	const cutoff = Date.now() - 15 * 60_000;
	while (failures.length && failures[0] < cutoff) failures.shift();
	return failures.length >= 5;
}

// ---------------------------------------------------------------- helpers

function json(body: unknown, status = 200, cookie?: string): Response {
	const headers = new Headers({
		"Content-Type": "application/json",
		"Cache-Control": "no-store",
	});
	if (cookie) headers.append("Set-Cookie", cookie);
	return new Response(JSON.stringify(body), { status, headers });
}

/** Origin and RP ID: COUCH_ORIGIN when set (production), else the request's own. */
function relyingParty(req: Request): {
	origin: string;
	rpID: string;
	secure: boolean;
} {
	const configured = process.env.COUCH_ORIGIN?.trim().replace(/\/$/, "");
	if (configured) {
		const u = new URL(configured);
		return {
			origin: u.origin,
			rpID: u.hostname,
			secure: u.protocol === "https:",
		};
	}
	const url = new URL(req.url);
	const proto =
		req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
	const host =
		req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
	const origin = `${proto}://${host}`;
	return { origin, rpID: new URL(origin).hostname, secure: proto === "https" };
}

interface PendingChallenge {
	challenge: string;
	purpose: "register" | "login";
	grant?: "session" | "setup" | "link";
	expiresAt: number;
}

function takeChallenge(
	purpose: PendingChallenge["purpose"],
): PendingChallenge | null {
	const c = getSetting<PendingChallenge>(CHALLENGE);
	deleteSetting(CHALLENGE);
	return c && c.purpose === purpose && c.expiresAt > Date.now() ? c : null;
}

function signedIn(req: Request): boolean {
	return validSession(readCookie(req.headers.get("cookie"), SESSION_COOKIE));
}

async function body<T>(req: Request): Promise<Partial<T>> {
	try {
		return (await req.json()) as Partial<T>;
	} catch {
		return {};
	}
}

function deviceName(ua: string | null): string {
	if (!ua) return "Passkey";
	if (/iPhone/.test(ua)) return "iPhone";
	if (/iPad/.test(ua)) return "iPad";
	if (/Android/.test(ua)) return "Android";
	if (/Macintosh/.test(ua)) return "Mac";
	if (/Windows/.test(ua)) return "Windows";
	return "Passkey";
}

// ----------------------------------------------------------------- routes

export default defineEventHandler(async (event) => {
	const req = event.req as Request;
	const path = new URL(req.url).pathname.replace(/\/$/, "");
	const method = req.method;
	const rp = relyingParty(req);

	if (path === "/auth/status" && method === "GET") {
		return json({
			enabled: authEnabled(),
			hasPasskeys: hasPasskeys(),
			signedIn: !authEnabled() || signedIn(req),
		});
	}
	if (!authEnabled())
		return json({ error: "Auth is not enabled (set COUCH_SETUP_CODE)." }, 400);

	// ---- registration
	if (path === "/auth/register/options" && method === "POST") {
		const b = await body<{ setupCode: string; linkCode: string }>(req);
		let grant: PendingChallenge["grant"];
		if (signedIn(req)) grant = "session";
		else if (throttled())
			return json(
				{ error: "Too many attempts. Try again in 15 minutes." },
				429,
			);
		else if (b.linkCode && linkCodeValid(b.linkCode)) grant = "link";
		else if (
			b.setupCode &&
			!hasPasskeys() &&
			safeEqual(b.setupCode, setupCode() ?? "")
		)
			grant = "setup";
		else {
			failures.push(Date.now());
			log.warn("AUTH_REGISTER_DENIED", {
				hadSetupCode: Boolean(b.setupCode),
				hadLinkCode: Boolean(b.linkCode),
			});
			return json(
				{
					error: hasPasskeys()
						? "That code is wrong or has expired."
						: "That setup code is wrong.",
				},
				403,
			);
		}
		const existing = listPasskeys();
		const options = await generateRegistrationOptions({
			rpName: "Couch",
			rpID: rp.rpID,
			userName: "couch",
			userDisplayName: "Couch",
			userID: new TextEncoder().encode("couch-owner"),
			attestationType: "none",
			excludeCredentials: existing.map((p) => ({
				id: p.id,
				transports: p.transports,
			})),
			authenticatorSelection: {
				residentKey: "required",
				userVerification: "required",
			},
		});
		setSetting(CHALLENGE, {
			challenge: options.challenge,
			purpose: "register",
			grant,
			expiresAt: Date.now() + CHALLENGE_MS,
		} satisfies PendingChallenge);
		return json(options);
	}

	if (path === "/auth/register/verify" && method === "POST") {
		const pending = takeChallenge("register");
		if (!pending)
			return json({ error: "That attempt expired. Start again." }, 400);
		const b = await body<{
			response: Parameters<typeof verifyRegistrationResponse>[0]["response"];
			name: string;
		}>(req);
		if (!b.response) return json({ error: "Missing response." }, 400);
		try {
			const { verified, registrationInfo } = await verifyRegistrationResponse({
				response: b.response,
				expectedChallenge: pending.challenge,
				expectedOrigin: rp.origin,
				expectedRPID: rp.rpID,
				requireUserVerification: true,
			});
			if (!verified)
				return json({ error: "Passkey could not be verified." }, 400);
			const { credential, credentialBackedUp } = registrationInfo;
			savePasskey({
				id: credential.id,
				publicKey: credential.publicKey,
				counter: credential.counter,
				transports: credential.transports ?? [],
				name: (
					b.name?.trim() || deviceName(req.headers.get("user-agent"))
				).slice(0, 60),
				backedUp: credentialBackedUp,
			});
			if (pending.grant === "link") consumeLinkCode();
			log.info("AUTH_PASSKEY_ADDED", { grant: pending.grant });
			if (pending.grant === "session") return json({ ok: true });
			const s = createSession(req.headers.get("user-agent"));
			return json(
				{ ok: true },
				200,
				sessionCookie(s.token, s.maxAge, rp.secure),
			);
		} catch (error) {
			log.warn("AUTH_REGISTER_FAILED", undefined, error);
			return json(
				{
					error:
						error instanceof Error ? error.message : "Registration failed.",
				},
				400,
			);
		}
	}

	// ---- sign in
	if (path === "/auth/login/options" && method === "POST") {
		// No allowCredentials: the browser offers whichever Couch passkey it has.
		const options = await generateAuthenticationOptions({
			rpID: rp.rpID,
			userVerification: "required",
		});
		setSetting(CHALLENGE, {
			challenge: options.challenge,
			purpose: "login",
			expiresAt: Date.now() + CHALLENGE_MS,
		} satisfies PendingChallenge);
		return json(options);
	}

	if (path === "/auth/login/verify" && method === "POST") {
		const pending = takeChallenge("login");
		if (!pending)
			return json({ error: "That attempt expired. Try again." }, 400);
		const b = await body<{
			response: Parameters<typeof verifyAuthenticationResponse>[0]["response"];
		}>(req);
		const passkey = b.response?.id ? getPasskey(b.response.id) : null;
		if (!b.response || !passkey) {
			log.warn("AUTH_LOGIN_UNKNOWN_PASSKEY");
			return json({ error: "This passkey isn't registered with Couch." }, 400);
		}
		try {
			const { verified, authenticationInfo } =
				await verifyAuthenticationResponse({
					response: b.response,
					expectedChallenge: pending.challenge,
					expectedOrigin: rp.origin,
					expectedRPID: rp.rpID,
					credential: {
						id: passkey.id,
						publicKey: passkey.publicKey as Uint8Array<ArrayBuffer>,
						counter: passkey.counter,
						transports: passkey.transports as never,
					},
					requireUserVerification: true,
				});
			if (!verified)
				return json({ error: "Passkey could not be verified." }, 400);
			markPasskeyUsed(passkey.id, authenticationInfo.newCounter);
			const s = createSession(req.headers.get("user-agent"));
			log.info("AUTH_SIGNED_IN", { passkey: passkey.name });
			return json(
				{ ok: true },
				200,
				sessionCookie(s.token, s.maxAge, rp.secure),
			);
		} catch (error) {
			log.warn("AUTH_LOGIN_FAILED", undefined, error);
			return json(
				{ error: error instanceof Error ? error.message : "Sign-in failed." },
				400,
			);
		}
	}

	if (path === "/auth/logout" && method === "POST") {
		endSession(readCookie(req.headers.get("cookie"), SESSION_COOKIE));
		return json({ ok: true }, 200, clearedCookie(rp.secure));
	}

	// ---- management (signed in only)
	if (!signedIn(req)) return json({ error: "Sign in first." }, 401);

	if (path === "/auth/passkeys" && method === "GET") {
		return json(
			listPasskeys().map((p) => ({
				id: p.id,
				name: p.name,
				backedUp: p.backedUp,
				createdAt: p.createdAt,
				lastUsedAt: p.lastUsedAt,
			})),
		);
	}

	if (path === "/auth/passkeys/remove" && method === "POST") {
		const b = await body<{ id: string }>(req);
		if (listPasskeys().length <= 1) {
			return json(
				{ error: "That's your only passkey. Add another before removing it." },
				400,
			);
		}
		if (b.id) removePasskey(b.id);
		log.info("AUTH_PASSKEY_REMOVED");
		return json({ ok: true });
	}

	if (path === "/auth/link-code" && method === "POST") {
		log.info("AUTH_LINK_CODE_CREATED");
		return json(createLinkCode());
	}

	return json({ error: "Not found." }, 404);
});
