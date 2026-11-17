import { useRouter } from "@tanstack/react-router";
import { DrawablyButton } from "drawably/react";
import { useState } from "react";
import { relativeTime } from "../lib/format.ts";
import { runSync } from "../server/fns.ts";

type BtnState = "idle" | "loading" | "success" | "error";

export function SyncButton({ lastSync }: { lastSync: string | null }) {
	const router = useRouter();
	const [state, setState] = useState<BtnState>("idle");
	const [error, setError] = useState<string | null>(null);

	async function sync() {
		setState("loading");
		setError(null);
		const res = await runSync({ data: {} });
		if (res.ok) {
			setState("success");
			await router.invalidate();
		} else {
			setState("error");
			setError(res.error);
		}
		setTimeout(() => setState("idle"), 2500);
	}

	return (
		<div className="flex items-center gap-2">
			<span
				className="hidden text-[12px] sm:inline"
				style={{ color: error ? "var(--drawably-error)" : "var(--text-3)" }}
				title={error ?? undefined}
			>
				{error ? "Sync failed" : `Synced ${relativeTime(lastSync)}`}
			</span>
			<DrawablyButton
				seed={201}
				state={state}
				onClick={sync}
				className="text-[13px]"
			>
				Sync
			</DrawablyButton>
		</div>
	);
}
