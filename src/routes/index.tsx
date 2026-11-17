import { createFileRoute, Link } from "@tanstack/react-router";
import { ConnectSimkl } from "../components/ConnectSimkl.tsx";
import { Poster } from "../components/Poster.tsx";
import { relativeTime, untilDate } from "../lib/format.ts";
import { getStatus, getUpNext } from "../server/fns.ts";
import type { LibraryShow } from "../server/library.ts";

export const Route = createFileRoute("/")({
	component: UpNextPage,
	loader: async () => {
		const status = await getStatus();
		return { status, upNext: status.simklConnected ? await getUpNext() : null };
	},
});

function UpNextPage() {
	const { status, upNext } = Route.useLoaderData();

	if (!status.simklConnected || !upNext) {
		return <ConnectSimkl configured={status.simklConfigured} />;
	}

	const empty =
		!upNext.continueWatching.length &&
		!upNext.newEpisodes.length &&
		!upNext.comingSoon.length &&
		!upNext.stalled.length;

	if (empty) {
		return (
			<section className="panel p-6">
				<h2 className="text-lg font-semibold">Nothing queued up</h2>
				<p className="mt-2 text-[14px]" style={{ color: "var(--text-2)" }}>
					No shows in progress on Simkl.{" "}
					<Link to="/picks" className="underline">
						See your picks
					</Link>{" "}
					for something new.
				</p>
			</section>
		);
	}

	return (
		<div className="space-y-10">
			<Shelf
				title="Continue watching"
				shows={upNext.continueWatching}
				meta={(s) => `Next ${s.nextToWatch ?? "episode"}`}
				detail={(s) => `${s.watched}/${s.total} episodes`}
			/>
			<Shelf
				title="New episodes"
				hint="Shows you finished or paused that have aired more"
				shows={upNext.newEpisodes}
				meta={(s) => `${s.total - s.watched} new`}
				detail={(s) => (s.status === "hold" ? "On hold" : "Was completed")}
			/>
			<Shelf
				title="Coming soon"
				hint="Next episode airs within 30 days"
				shows={upNext.comingSoon}
				meta={(s) => untilDate(s.nextAirDate)}
				detail={(s) => s.providers[0] ?? ""}
			/>
			<Shelf
				title="Stalled"
				hint="Watching, but nothing in a while. Pick it back up, or drop it on Simkl."
				shows={upNext.stalled}
				meta={(s) => `Stopped at ${s.lastWatched ?? "?"}`}
				detail={(s) => relativeTime(s.lastWatchedAt)}
				muted
			/>
		</div>
	);
}

function Shelf({
	title,
	hint,
	shows,
	meta,
	detail,
	muted = false,
}: {
	title: string;
	hint?: string;
	shows: LibraryShow[];
	meta: (s: LibraryShow) => string;
	detail: (s: LibraryShow) => string;
	muted?: boolean;
}) {
	if (!shows.length) return null;
	return (
		<section>
			<div className="mb-4 flex items-baseline gap-3">
				<h2 className="text-[17px] font-semibold">{title}</h2>
				<span className="tnum text-[12px]" style={{ color: "var(--text-3)" }}>
					{shows.length}
				</span>
				{hint && (
					<span
						className="hidden text-[13px] sm:inline"
						style={{ color: "var(--text-3)" }}
					>
						{hint}
					</span>
				)}
			</div>
			<div className="grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
				{shows.map((s) => (
					<a
						key={s.simklId}
						href={s.simklUrl}
						target="_blank"
						rel="noreferrer"
						className="group block"
					>
						<Poster
							title={s.title}
							src={s.poster}
							subtitle={s.year ? String(s.year) : null}
							progress={s.total ? s.watched / s.total : undefined}
							dim={muted}
						/>
						<div className="mt-2 truncate text-[14px] font-medium">
							{s.title}
						</div>
						<div
							className="text-[12px]"
							style={{ color: "var(--accent-deep)" }}
						>
							{meta(s)}
						</div>
						<div
							className="tnum truncate text-[11px]"
							style={{ color: "var(--text-3)" }}
						>
							{detail(s)}
						</div>
					</a>
				))}
			</div>
		</section>
	);
}
