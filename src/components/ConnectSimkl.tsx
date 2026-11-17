import { useRouter } from "@tanstack/react-router";
import { DrawablyButton } from "drawably/react";
import { useEffect, useRef, useState } from "react";
import { beginSimklLogin, checkSimklLogin, runSync } from "../server/fns.ts";

/**
 * Simkl's device flow in the browser: show a code, the user enters it at
 * simkl.com/pin, we poll until approved, then run the first sync.
 */
export function ConnectSimkl({ configured }: { configured: boolean }) {
	const router = useRouter();
	const [code, setCode] = useState<{
		userCode: string;
		verificationUrl: string;
	} | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useEffect(() => () => clearTimeout(timer.current), []);

	if (!configured) {
		return (
			<section className="panel p-6">
				<h2 className="text-lg font-semibold">Connect Simkl</h2>
				<p className="mt-2 text-[14px]" style={{ color: "var(--text-2)" }}>
					Set <code className="tnum">SIMKL_CLIENT_ID</code> first: create an app
					of type <em>TV / devices / CLI</em> at{" "}
					<a
						className="underline"
						href="https://simkl.com/settings/developer/"
						target="_blank"
						rel="noreferrer"
					>
						simkl.com/settings/developer
					</a>
					, add its client ID to the environment, and restart.
				</p>
			</section>
		);
	}

	async function poll(intervalSec: number) {
		const res = await checkSimklLogin();
		if (!res.ok) {
			setMessage(res.error);
			setCode(null);
			setBusy(false);
			return;
		}
		if (res.value === "done") {
			setMessage("Connected. Pulling your shows...");
			await runSync({ data: {} });
			await router.invalidate();
			return;
		}
		if (res.value === "expired") {
			setMessage("The code expired. Try again.");
			setCode(null);
			setBusy(false);
			return;
		}
		const next = res.value === "slow_down" ? intervalSec + 5 : intervalSec;
		timer.current = setTimeout(() => poll(next), next * 1000);
	}

	async function start() {
		setBusy(true);
		setMessage(null);
		const res = await beginSimklLogin();
		if (!res.ok) {
			setMessage(res.error);
			setBusy(false);
			return;
		}
		setCode(res.value);
		timer.current = setTimeout(
			() => poll(res.value.interval),
			res.value.interval * 1000,
		);
	}

	return (
		<section className="panel p-6">
			<h2 className="text-lg font-semibold">Connect Simkl</h2>
			<p
				className="mt-2 max-w-prose text-[14px]"
				style={{ color: "var(--text-2)" }}
			>
				Couch reads your TV library from Simkl: what you are watching, finished,
				paused and dropped, and your ratings. It never changes anything in your
				Simkl account.
			</p>
			{code ? (
				<div className="mt-5">
					<p className="text-[14px]" style={{ color: "var(--text-2)" }}>
						Open{" "}
						<a
							className="underline"
							href={code.verificationUrl}
							target="_blank"
							rel="noreferrer"
						>
							simkl.com/pin
						</a>{" "}
						and enter:
					</p>
					<div className="tnum mt-2 text-[34px] font-semibold tracking-widest">
						{code.userCode}
					</div>
					<p className="mt-2 text-[13px]" style={{ color: "var(--text-3)" }}>
						Waiting for approval...
					</p>
				</div>
			) : (
				<div className="mt-5">
					<DrawablyButton
						seed={301}
						variant="solid"
						onClick={start}
						disabled={busy}
					>
						Connect Simkl
					</DrawablyButton>
				</div>
			)}
			{message && (
				<p className="mt-3 text-[13px]" style={{ color: "var(--text-2)" }}>
					{message}
				</p>
			)}
		</section>
	);
}
