import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const work = mkdtempSync(join(tmpdir(), "couch-auth-"));
process.env.COUCH_DB_PATH = join(work, "couch.db");
process.env.COUCH_SETUP_CODE = "correct horse battery staple";

const { closeDb, getDb, setSetting } = await import(
	"../src/server/db/index.ts"
);
const store = await import("../src/server/auth/store.ts");

after(() => {
	closeDb();
	rmSync(work, { recursive: true, force: true });
});

test("auth is enabled by the setup code", () => {
	assert.equal(store.authEnabled(), true);
	assert.equal(store.setupCode(), "correct horse battery staple");
	assert.equal(store.safeEqual("a", "a"), true);
	assert.equal(store.safeEqual("a", "ab"), false);
});

test("sessions validate, store only a hash, and end", () => {
	const { token, maxAge } = store.createSession("UA");
	assert.equal(maxAge, store.SESSION_DAYS * 86_400);
	assert.equal(store.validSession(token), true);
	assert.equal(store.validSession("nope"), false);
	assert.equal(store.validSession(undefined), false);
	const stored = getDb().prepare("SELECT token_hash FROM session").all() as {
		token_hash: string;
	}[];
	assert.ok(
		stored.every((r) => r.token_hash !== token),
		"raw token is never stored",
	);
	store.endSession(token);
	assert.equal(store.validSession(token), false);
});

test("expired sessions are rejected and removed", () => {
	const { token } = store.createSession(null);
	getDb()
		.prepare("UPDATE session SET expires_at = '2000-01-01T00:00:00Z'")
		.run();
	assert.equal(store.validSession(token), false);
	assert.equal(
		(
			getDb().prepare("SELECT COUNT(*) AS n FROM session").get() as {
				n: number;
			}
		).n,
		0,
	);
});

test("cookies are parsed and built with safe attributes", () => {
	assert.equal(
		store.readCookie("a=1; couch_session=abc%3D; b=2", "couch_session"),
		"abc=",
	);
	assert.equal(store.readCookie(null, "couch_session"), undefined);
	const c = store.sessionCookie("t", 60, true);
	for (const part of [
		"HttpOnly",
		"SameSite=Lax",
		"Secure",
		"Path=/",
		"Max-Age=60",
	])
		assert.ok(c.includes(part), part);
	assert.ok(!store.sessionCookie("t", 60, false).includes("Secure"));
});

test("link codes work once-ish, ignore formatting, and expire", () => {
	const { code } = store.createLinkCode();
	assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
	assert.equal(store.linkCodeValid(code.toLowerCase().replace("-", " ")), true);
	assert.equal(store.linkCodeValid("AAAA-AAAA"), false);
	store.consumeLinkCode();
	assert.equal(store.linkCodeValid(code), false, "consumed");
	const second = store.createLinkCode();
	setSetting("auth.link_code", {
		hash: "00",
		expiresAt: "2000-01-01T00:00:00Z",
	});
	assert.equal(store.linkCodeValid(second.code), false, "expired");
});

test("passkeys round-trip and reset clears passkeys and sessions", () => {
	assert.equal(store.hasPasskeys(), false);
	store.savePasskey({
		id: "cred-1",
		publicKey: new Uint8Array([1, 2, 3]),
		counter: 0,
		transports: ["internal"],
		name: "Mac",
		backedUp: true,
	});
	const p = store.getPasskey("cred-1");
	assert.deepEqual([...(p?.publicKey ?? [])], [1, 2, 3]);
	assert.deepEqual(p?.transports, ["internal"]);
	store.markPasskeyUsed("cred-1", 5);
	assert.equal(store.getPasskey("cred-1")?.counter, 5);
	store.createSession(null);
	assert.deepEqual(store.resetAuth(), { passkeys: 1, sessions: 1 });
	assert.equal(store.hasPasskeys(), false);
});
