import {
	startAuthentication,
	startRegistration,
} from "@simplewebauthn/browser";
import { createFileRoute } from "@tanstack/react-router";
import { DrawablyButton } from "drawably/react";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/login")({
	validateSearch: (s: Record<string, unknown>): { next?: string } =>
		// Only same-site paths, never an absolute URL (open-redirect guard).
		typeof s.next === "string" &&
		s.next.startsWith("/") &&
		!s.next.startsWith("//")
			? { next: s.next }
			: {},
	component: LoginPage,
});

type Status = { enabled: boolean; hasPasskeys: boolean; signedIn: boolean };
type BtnState = "idle" | "loading" | "success" | "error";

async function post<T>(path: string, body?: unknown): Promise<T> {
	const res = await fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
	const data = (await res.json().catch(() => ({}))) as T & { error?: string };
	if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
	return data;
}

/** Turn WebAuthn's DOMExceptions into something a person can act on. */
function friendly(error: unknown): string {
	if (error instanceof Error) {
		if (error.name === "NotAllowedError")
			return "Cancelled, or the passkey prompt timed out.";
		if (error.name === "InvalidStateError")
			return "This device already has a Couch passkey. Sign in instead.";
		return error.message;
	}
	return String(error);
}

function LoginPage() {
	const { next } = Route.useSearch();
	const [status, setStatus] = useState<Status | null>(null);
	const [mode, setMode] = useState<"signin" | "code">("signin");
	const [code, setCode] = useState("");
	const [state, setState] = useState<BtnState>("idle");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		fetch("/auth/status")
			.then((r) => r.json())
			.then((s: Status) => {
				if (s.signedIn) window.location.replace(next ?? "/");
				else setStatus(s);
			})
			.catch(() => setError("Couldn't reach Couch."));
	}, [next]);

	const done = () => window.location.replace(next ?? "/");

	async function signIn() {
		setState("loading");
		setError(null);
		try {
			const optionsJSON = await post<
				Parameters<typeof startAuthentication>[0]["optionsJSON"]
			>("/auth/login/options");
			const response = await startAuthentication({ optionsJSON });
			await post("/auth/login/verify", { response });
			setState("success");
			done();
		} catch (e) {
			setState("error");
			setError(friendly(e));
		}
	}

	async function register(grant: { setupCode?: string; linkCode?: string }) {
		setState("loading");
		setError(null);
		try {
			const optionsJSON = await post<
				Parameters<typeof startRegistration>[0]["optionsJSON"]
			>("/auth/register/options", grant);
			const response = await startRegistration({ optionsJSON });
			await post("/auth/register/verify", { response });
			setState("success");
			done();
		} catch (e) {
			setState("error");
			setError(friendly(e));
		}
	}

	const firstRun = status && !status.hasPasskeys;

	return (
		<div className="mx-auto mt-16 max-w-sm">
			<section className="panel p-6">
				<h1 className="pen text-[28px] leading-none">Couch</h1>
				{!status ? (
					<p className="mt-4 text-[14px]" style={{ color: "var(--text-3)" }}>
						{error ?? "Checking..."}
					</p>
				) : firstRun || mode === "code" ? (
					<form
						className="mt-4 space-y-3"
						onSubmit={(e) => {
							e.preventDefault();
							register(firstRun ? { setupCode: code } : { linkCode: code });
						}}
					>
						<p className="text-[14px]" style={{ color: "var(--text-2)" }}>
							{firstRun
								? "Set up a passkey for this device. Enter the setup code from the server's COUCH_SETUP_CODE."
								: "Enter the code shown on a device that's already signed in (Passkeys > Add another device)."}
						</p>
						<input
							className="field h-10 w-full px-3 text-[15px] tnum"
							type={firstRun ? "password" : "text"}
							autoComplete="off"
							placeholder={firstRun ? "Setup code" : "XXXX-XXXX"}
							value={code}
							onChange={(e) => setCode(e.target.value)}
						/>
						<DrawablyButton
							seed={801}
							variant="solid"
							state={state}
							type="submit"
							disabled={!code.trim()}
						>
							Create passkey
						</DrawablyButton>
						{!firstRun && (
							<button
								type="button"
								className="block text-[13px] underline"
								onClick={() => setMode("signin")}
							>
								Back to sign in
							</button>
						)}
					</form>
				) : (
					<div className="mt-4 space-y-3">
						<p className="text-[14px]" style={{ color: "var(--text-2)" }}>
							Sign in with your passkey: fingerprint, face or device PIN.
						</p>
						<DrawablyButton
							seed={802}
							variant="solid"
							state={state}
							onClick={signIn}
						>
							Sign in with passkey
						</DrawablyButton>
						<button
							type="button"
							className="block text-[13px] underline"
							onClick={() => setMode("code")}
						>
							New device? Use a code
						</button>
					</div>
				)}
				{error && status && (
					<p
						className="mt-3 text-[13px]"
						style={{ color: "var(--drawably-error)" }}
					>
						{error}
					</p>
				)}
			</section>
		</div>
	);
}
