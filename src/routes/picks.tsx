import { createFileRoute, useRouter } from "@tanstack/react-router";
import { DrawablyButton } from "drawably/react";
import { useState } from "react";
import { Poster } from "../components/Poster.tsx";
import { relativeTime } from "../lib/format.ts";
import { generatePicks, getPicks, getStatus, ratePick } from "../server/fns.ts";
import type { Pick } from "../server/picks.ts";

export const Route = createFileRoute("/picks")({
	component: PicksPage,
	loader: async () => ({ status: await getStatus(), picks: await getPicks() }),
});

type BtnState = "idle" | "loading" | "success" | "error";

function PicksPage() {
	const { status, picks } = Route.useLoaderData();
	const router = useRouter();
	const [state, setState] = useState<BtnState>("idle");
	const [error, setError] = useState<string | null>(null);

	const missing = [
		!status.simklConnected && "connect Simkl",
		!status.tmdbConfigured && "set TMDB_API_KEY",
		!status.openRouterConfigured && "set OPENROUTER_API_KEY",
	].filter(Boolean);

	async function refresh() {
		setState("loading");
		setError(null);
		const res = await generatePicks();
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
		<div>
			<div className="mb-6 flex flex-wrap items-end gap-4">
				<div>
					<h1 className="text-[22px] font-semibold">Picks</h1>
					<p className="text-[13px]" style={{ color: "var(--text-3)" }}>
						{picks.createdAt
							? `Chosen ${relativeTime(picks.createdAt)} by ${picks.model}`
							: "Shows chosen for you from your taste profile."}
					</p>
				</div>
				<div className="ml-auto flex items-center gap-3">
					{state === "loading" && (
						<span className="text-[12px]" style={{ color: "var(--text-3)" }}>
							Takes about a minute
						</span>
					)}
					<DrawablyButton
						seed={401}
						variant="solid"
						state={state}
						onClick={refresh}
						disabled={missing.length > 0}
						title="Runs one OpenRouter call (a few cents)"
					>
						{picks.picks.length ? "New picks" : "Get picks"}
					</DrawablyButton>
				</div>
			</div>

			{missing.length > 0 && (
				<p
					className="panel mb-6 p-4 text-[14px]"
					style={{ color: "var(--text-2)" }}
				>
					To get picks, {missing.join(", ")}.
				</p>
			)}
			{error && (
				<p
					className="panel mb-6 p-4 text-[14px]"
					style={{ color: "var(--drawably-error)" }}
				>
					{error}
				</p>
			)}

			<div className="space-y-4">
				{picks.picks.map((p) => (
					<PickCard key={`${p.runId}-${p.tmdbId}`} pick={p} />
				))}
			</div>
		</div>
	);
}

function PickCard({ pick }: { pick: Pick }) {
	const [feedback, setFeedback] = useState(pick.feedback);

	async function rate(value: 1 | -1) {
		const next = feedback === value ? null : value;
		setFeedback(next);
		await ratePick({
			data: { runId: pick.runId, tmdbId: pick.tmdbId, feedback: next },
		});
	}

	const tmdbUrl = `https://www.themoviedb.org/tv/${pick.tmdbId}`;

	return (
		<article className="panel flex gap-4 p-4 sm:gap-6 sm:p-5">
			<a
				href={tmdbUrl}
				target="_blank"
				rel="noreferrer"
				className="group block w-24 shrink-0 sm:w-32"
			>
				<Poster title={pick.title} src={pick.poster} subtitle={pick.year} />
			</a>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
					<span className="tnum text-[12px]" style={{ color: "var(--text-3)" }}>
						{String(pick.rank).padStart(2, "0")}
					</span>
					<a
						href={tmdbUrl}
						target="_blank"
						rel="noreferrer"
						className="text-[18px] font-semibold hover:underline"
					>
						{pick.title}
					</a>
					<span className="text-[13px]" style={{ color: "var(--text-3)" }}>
						{[
							pick.year,
							pick.seasons
								? `${pick.seasons} season${pick.seasons === 1 ? "" : "s"}`
								: null,
							pick.status,
						]
							.filter(Boolean)
							.join(" · ")}
					</span>
				</div>
				<p
					className="mt-2 max-w-prose text-[15px] leading-relaxed"
					style={{ color: "var(--text-2)" }}
				>
					{pick.reason}
				</p>
				<div className="mt-3 flex flex-wrap items-center gap-2">
					{pick.providers.length ? (
						pick.providers.map((p) => (
							<a
								key={p}
								href={pick.providersLink ?? tmdbUrl}
								target="_blank"
								rel="noreferrer"
								className={`chip ${pick.onMyServices ? "chip-accent" : ""}`}
							>
								{p}
							</a>
						))
					) : (
						<span className="chip">Not streaming nearby</span>
					)}
					{pick.genres.slice(0, 3).map((g) => (
						<span key={g} className="chip">
							{g}
						</span>
					))}
					<div className="ml-auto flex gap-1">
						<FeedbackButton
							active={feedback === 1}
							onClick={() => rate(1)}
							label="Good pick"
						>
							<path d="M7 11v9H4v-9h3Zm2 9h8.3a2 2 0 0 0 2-1.6l1.2-6A2 2 0 0 0 18.5 10H14V5.5A2.5 2.5 0 0 0 11.5 3L9 11v9Z" />
						</FeedbackButton>
						<FeedbackButton
							active={feedback === -1}
							onClick={() => rate(-1)}
							label="Not for me"
						>
							<path d="M17 13V4h3v9h-3Zm-2-9H6.7a2 2 0 0 0-2 1.6l-1.2 6A2 2 0 0 0 5.5 14H10v4.5a2.5 2.5 0 0 0 2.5 2.5L15 13V4Z" />
						</FeedbackButton>
					</div>
				</div>
			</div>
		</article>
	);
}

function FeedbackButton({
	active,
	onClick,
	label,
	children,
}: {
	active: boolean;
	onClick: () => void;
	label: string;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`btn grid h-8 w-8 place-items-center ${active ? "btn-accent" : ""}`}
			aria-label={label}
			aria-pressed={active}
			title={label}
		>
			<svg
				aria-hidden="true"
				width="15"
				height="15"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.7"
				strokeLinejoin="round"
			>
				{children}
			</svg>
		</button>
	);
}
