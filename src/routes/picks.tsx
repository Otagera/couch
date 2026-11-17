import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { DrawablyButton } from "drawably/react";
import { useState } from "react";
import { Poster } from "../components/Poster.tsx";
import { relativeTime } from "../lib/format.ts";
import {
	generatePicks,
	getAllPicks,
	getStatus,
	ratePick,
} from "../server/fns.ts";
import type { Pick } from "../server/picks.ts";

type Tab = "all" | "tv" | "movie";
const TABS: [Tab, string][] = [
	["all", "All"],
	["tv", "TV"],
	["movie", "Films"],
];

export const Route = createFileRoute("/picks")({
	// Optional so plain links to /picks need no search params; "All" is default.
	validateSearch: (s: Record<string, unknown>): { kind?: "tv" | "movie" } =>
		s.kind === "tv" || s.kind === "movie" ? { kind: s.kind } : {},
	loader: async () => ({
		status: await getStatus(),
		picks: await getAllPicks(),
	}),
	component: PicksPage,
});

type BtnState = "idle" | "loading" | "success" | "error";

/** Alternate TV and film picks by rank: TV 1, Film 1, TV 2, Film 2, ... */
function interleave(a: Pick[], b: Pick[]): Pick[] {
	const out: Pick[] = [];
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		if (a[i]) out.push(a[i]);
		if (b[i]) out.push(b[i]);
	}
	return out;
}

function PicksPage() {
	const { status, picks } = Route.useLoaderData();
	const tab: Tab = Route.useSearch().kind ?? "all";

	const missingFor = (kind: "tv" | "movie") =>
		[
			kind === "tv" && !status.simklConnected && "connect Simkl",
			kind === "movie" &&
				!status.films.watched &&
				"add your Letterboxd export or set LETTERBOXD_USERNAME, then sync",
			!status.tmdbConfigured && "set TMDB_API_KEY",
			!status.openRouterConfigured && "set OPENROUTER_API_KEY",
		].filter((x): x is string => Boolean(x));

	const shown =
		tab === "all"
			? interleave(picks.tv.picks, picks.movie.picks)
			: tab === "tv"
				? picks.tv.picks
				: picks.movie.picks;
	const kinds: ("tv" | "movie")[] = tab === "all" ? ["tv", "movie"] : [tab];

	return (
		<div>
			<div className="mb-2 flex gap-1" role="tablist">
				{TABS.map(([k, label]) => (
					<Link
						key={k}
						to="/picks"
						search={k === "all" ? {} : { kind: k }}
						className="tab"
						role="tab"
						aria-selected={k === tab}
					>
						{label}
					</Link>
				))}
			</div>
			<div className="mb-6 flex flex-wrap items-end gap-4">
				<div>
					<h1 className="text-[22px] font-semibold">Picks</h1>
					<p className="text-[13px]" style={{ color: "var(--text-3)" }}>
						{kinds
							.map((k) => {
								const p = k === "tv" ? picks.tv : picks.movie;
								const label = k === "tv" ? "TV" : "Films";
								return p.createdAt
									? `${label}: ${relativeTime(p.createdAt)} by ${p.model}`
									: `${label}: none yet`;
							})
							.join(" · ")}
					</p>
				</div>
				<div className="ml-auto flex flex-wrap items-center gap-2">
					{kinds.map((k) => (
						<GenerateButton
							key={k}
							kind={k}
							label={tab === "all"}
							missing={missingFor(k)}
						/>
					))}
				</div>
			</div>

			{kinds.map((k) => {
				const missing = missingFor(k);
				return missing.length ? (
					<p
						key={k}
						className="panel mb-4 p-4 text-[14px]"
						style={{ color: "var(--text-2)" }}
					>
						To get {k === "tv" ? "TV" : "film"} picks, {missing.join(", ")}.
					</p>
				) : null;
			})}

			<div className="space-y-4">
				{shown.map((p) => (
					<PickCard
						key={`${p.kind}-${p.runId}-${p.tmdbId}`}
						pick={p}
						showKind={tab === "all"}
					/>
				))}
			</div>
		</div>
	);
}

function GenerateButton({
	kind,
	label,
	missing,
}: {
	kind: "tv" | "movie";
	label: boolean;
	missing: string[];
}) {
	const router = useRouter();
	const [state, setState] = useState<BtnState>("idle");
	const [error, setError] = useState<string | null>(null);

	async function run() {
		setState("loading");
		setError(null);
		const res = await generatePicks({ data: { kind } });
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
		<div className="flex flex-col items-end">
			<DrawablyButton
				seed={kind === "tv" ? 401 : 402}
				variant="solid"
				state={state}
				onClick={run}
				disabled={missing.length > 0}
				title="One OpenRouter call, well under a cent"
			>
				{label ? `New ${kind === "tv" ? "TV" : "film"} picks` : "New picks"}
			</DrawablyButton>
			{state === "loading" && (
				<span className="mt-1 text-[11px]" style={{ color: "var(--text-3)" }}>
					Takes about a minute
				</span>
			)}
			{error && (
				<span
					className="mt-1 max-w-xs text-right text-[12px]"
					style={{ color: "var(--drawably-error)" }}
				>
					{error}
				</span>
			)}
		</div>
	);
}

function PickCard({ pick, showKind }: { pick: Pick; showKind: boolean }) {
	const [feedback, setFeedback] = useState(pick.feedback);

	async function rate(value: 1 | -1) {
		const next = feedback === value ? null : value;
		setFeedback(next);
		await ratePick({
			data: { runId: pick.runId, tmdbId: pick.tmdbId, feedback: next },
		});
	}

	const tmdbUrl = pick.tmdbUrl;

	return (
		<article className="panel flex gap-4 p-4 sm:gap-6 sm:p-5">
			<a
				href={tmdbUrl}
				target="_blank"
				rel="noreferrer"
				className="group relative block w-24 shrink-0 sm:w-32"
			>
				<Poster title={pick.title} src={pick.poster} subtitle={pick.year} />
				{showKind && (
					<span
						className={`kind-tag kind-${pick.kind === "tv" ? "tv" : "film"}`}
					>
						{pick.kind === "tv" ? "TV" : "Film"}
					</span>
				)}
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
						{[pick.year, pick.detail].filter(Boolean).join(" · ")}
					</span>
				</div>
				<p
					className="mt-2 max-w-prose text-[15px] leading-relaxed"
					style={{ color: "var(--text-2)" }}
				>
					{pick.reason}
				</p>
				<div className="mt-3 flex flex-wrap items-center gap-2">
					{pick.local && (
						<span className="chip chip-accent">On your drive</span>
					)}
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
