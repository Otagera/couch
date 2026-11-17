import { startRegistration } from "@simplewebauthn/browser";
import { createFileRoute } from "@tanstack/react-router";
import { DrawablyButton } from "drawably/react";
import { useCallback, useEffect, useState } from "react";
import { relativeTime } from "../lib/format.ts";

export const Route = createFileRoute("/passkeys")({ component: PasskeysPage });

interface Passkey {
	id: string;
	name: string;
	backedUp: boolean;
	createdAt: string;
	lastUsedAt: string | null;
}

async function call<T>(
	path: string,
	method = "POST",
	body?: unknown,
): Promise<T> {
	const res = await fetch(path, {
		method,
		headers: body ? { "Content-Type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : method === "POST" ? "{}" : undefined,
	});
	const data = (await res.json().catch(() => ({}))) as T & { error?: string };
	if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
	return data;
}

function PasskeysPage() {
	const [keys, setKeys] = useState<Passkey[] | null>(null);
	const [enabled, setEnabled] = useState(true);
	const [linkCode, setLinkCode] = useState<{
		code: string;
		expiresAt: string;
	} | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [addState, setAddState] = useState<
		"idle" | "loading" | "success" | "error"
	>("idle");

	const load = useCallback(async () => {
		const status = await call<{ enabled: boolean }>("/auth/status", "GET");
		setEnabled(status.enabled);
		if (status.enabled) setKeys(await call<Passkey[]>("/auth/passkeys", "GET"));
	}, []);

	useEffect(() => {
		load().catch((e) => setError(String(e.message ?? e)));
	}, [load]);

	async function addHere() {
		setAddState("loading");
		setError(null);
		try {
			const optionsJSON = await call<
				Parameters<typeof startRegistration>[0]["optionsJSON"]
			>("/auth/register/options");
			await call("/auth/register/verify", "POST", {
				response: await startRegistration({ optionsJSON }),
			});
			setAddState("success");
			await load();
		} catch (e) {
			setAddState("error");
			setError(
				e instanceof Error && e.name === "InvalidStateError"
					? "This device already has a passkey."
					: String((e as Error).message ?? e),
			);
		}
	}

	async function remove(id: string) {
		setError(null);
		try {
			await call("/auth/passkeys/remove", "POST", { id });
			await load();
		} catch (e) {
			setError((e as Error).message);
		}
	}

	async function signOut() {
		await call("/auth/logout");
		window.location.replace("/login");
	}

	if (!enabled) {
		return (
			<section
				className="panel p-6 text-[14px]"
				style={{ color: "var(--text-2)" }}
			>
				Sign-in is off. Set <code className="tnum">COUCH_SETUP_CODE</code> to
				turn on passkey sign-in (required when deployed).
			</section>
		);
	}

	return (
		<div className="max-w-2xl space-y-8">
			<section>
				<div className="flex items-baseline gap-3">
					<h1 className="text-[22px] font-semibold">Passkeys</h1>
					<button
						type="button"
						onClick={signOut}
						className="ml-auto text-[13px] underline"
					>
						Sign out
					</button>
				</div>
				<p className="mt-1 text-[14px]" style={{ color: "var(--text-2)" }}>
					Couch signs in with passkeys only. Passkeys synced by iCloud Keychain
					or Google Password Manager work on all your devices.
				</p>
			</section>

			<section className="panel">
				{(keys ?? []).map((k, i) => (
					<div
						key={k.id}
						className="flex items-center gap-3 px-4 py-3"
						style={i ? { borderTop: "1px solid var(--hairline)" } : undefined}
					>
						<div className="min-w-0">
							<div className="text-[15px] font-medium">{k.name}</div>
							<div className="text-[12px]" style={{ color: "var(--text-3)" }}>
								Added {relativeTime(k.createdAt)} · last used{" "}
								{relativeTime(k.lastUsedAt)}
								{k.backedUp ? " · synced" : " · this device only"}
							</div>
						</div>
						<button
							type="button"
							onClick={() => remove(k.id)}
							className="ml-auto text-[13px] underline"
						>
							Remove
						</button>
					</div>
				))}
			</section>

			<section className="grid gap-4 sm:grid-cols-2">
				<div className="panel p-4">
					<h2 className="text-[15px] font-semibold">
						Add a passkey on this device
					</h2>
					<p
						className="mt-1 mb-3 text-[13px]"
						style={{ color: "var(--text-2)" }}
					>
						For a device that doesn't share your passkeys, like a second browser
						or a security key.
					</p>
					<DrawablyButton seed={901} state={addState} onClick={addHere}>
						Add passkey
					</DrawablyButton>
				</div>
				<div className="panel p-4">
					<h2 className="text-[15px] font-semibold">Add another device</h2>
					<p
						className="mt-1 mb-3 text-[13px]"
						style={{ color: "var(--text-2)" }}
					>
						Get a one-time code, then choose "New device? Use a code" on the
						other device's sign-in page.
					</p>
					{linkCode ? (
						<div>
							<div className="tnum text-[26px] font-semibold tracking-widest">
								{linkCode.code}
							</div>
							<div className="text-[12px]" style={{ color: "var(--text-3)" }}>
								Works once, for 10 minutes.
							</div>
						</div>
					) : (
						<DrawablyButton
							seed={902}
							onClick={async () =>
								setLinkCode(
									await call<{ code: string; expiresAt: string }>(
										"/auth/link-code",
									),
								)
							}
						>
							Get a code
						</DrawablyButton>
					)}
				</div>
			</section>

			{error && (
				<p className="text-[13px]" style={{ color: "var(--drawably-error)" }}>
					{error}
				</p>
			)}
			<p className="text-[12px]" style={{ color: "var(--text-3)" }}>
				Locked out? On the server run{" "}
				<code className="tnum">node src/server/cli.ts passkeys reset</code>,
				then sign in with the setup code again.
			</p>
		</div>
	);
}
