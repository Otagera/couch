import { createFileRoute, Link } from "@tanstack/react-router";
import { ConnectSimkl } from "../components/ConnectSimkl.tsx";
import { Poster } from "../components/Poster.tsx";
import { relativeTime, untilDate } from "../lib/format.ts";
import { getHome, getStatus } from "../server/fns.ts";
import type { HomeItem } from "../server/home.ts";
import type { LibraryShow } from "../server/library.ts";
import type { ListProgress } from "../server/lists.ts";

export const Route = createFileRoute("/")({
	component: HomePage,
	loader: async () => ({ status: await getStatus(), home: await getHome() }),
});

function HomePage() {
	const { status, home } = Route.useLoaderData();
	const hasFilms = status.films.watched > 0;

	if (!status.simklConnected && !hasFilms) {
		return <ConnectSimkl configured={status.simklConfigured} />;
	}

	const empty =
		!home.upNext.length &&
		!home.readyTonight.length &&
		!home.lists.length &&
		!home.comingSoon.length;

	return (
		<div className="space-y-12">
			{!status.simklConnected && (
				<ConnectSimkl configured={status.simklConfigured} />
			)}

			{empty && (
				<section className="panel p-6">
					<h2 className="text-lg font-semibold">Nothing queued up</h2>
					<p className="mt-2 text-[14px]" style={{ color: "var(--text-2)" }}>
						<Link to="/picks" className="underline">
							See your picks
						</Link>{" "}
						for something new.
					</p>
				</section>
			)}

			<ItemRow
				title="Up next"
				hint="Shows in progress and the next film in lists you're working through"
				items={home.upNext}
			/>
			<ItemRow
				title="Ready tonight"
				hint="New episodes, and watchlist films on your services"
				items={home.readyTonight}
				limit={12}
			/>
			<ListsSection lists={home.lists} />
			<ComingSoon shows={home.comingSoon} />
			<ShowShelf
				title="Paused"
				hint="Nothing in a few weeks. They'll keep."
				shows={home.paused}
			/>
			<ShowShelf
				title="On a long break"
				hint="Over six months since an episode"
				shows={home.longBreak}
				collapsed
			/>
		</div>
	);
}

// ------------------------------------------------------------------ pieces

function SectionHead({
	title,
	count,
	hint,
}: {
	title: string;
	count?: number;
	hint?: string;
}) {
	return (
		<>
			<h2 className="text-[17px] font-semibold">{title}</h2>
			{count !== undefined && (
				<span className="tnum text-[12px]" style={{ color: "var(--text-3)" }}>
					{count}
				</span>
			)}
			{hint && (
				<span
					className="hidden text-[13px] sm:inline"
					style={{ color: "var(--text-3)" }}
				>
					{hint}
				</span>
			)}
		</>
	);
}

function KindTag({ kind }: { kind: "tv" | "film" }) {
	return (
		<span className={`kind-tag kind-${kind}`}>
			{kind === "tv" ? "TV" : "Film"}
		</span>
	);
}

function ItemRow({
	title,
	hint,
	items,
	limit,
}: {
	title: string;
	hint: string;
	items: HomeItem[];
	limit?: number;
}) {
	if (!items.length) return null;
	const shown = limit ? items.slice(0, limit) : items;
	return (
		<section>
			<div className="mb-4 flex items-baseline gap-3">
				<SectionHead title={title} count={items.length} hint={hint} />
			</div>
			<div className="grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
				{shown.map((it) => (
					<a
						key={it.key}
						href={it.url}
						target="_blank"
						rel="noreferrer"
						className="group block"
					>
						<div className="relative">
							<Poster title={it.title} src={it.poster} progress={it.progress} />
							<KindTag kind={it.kind} />
						</div>
						<div className="mt-2 truncate text-[14px] font-medium">
							{it.title}
						</div>
						<div
							className="truncate text-[12px]"
							style={{ color: "var(--accent-deep)" }}
						>
							{it.meta}
						</div>
						<div
							className="tnum truncate text-[11px]"
							style={{ color: "var(--text-3)" }}
						>
							{it.detail}
						</div>
					</a>
				))}
			</div>
			{limit && items.length > limit && (
				<p className="mt-3 text-[13px]" style={{ color: "var(--text-3)" }}>
					and {items.length - limit} more
				</p>
			)}
		</section>
	);
}

function ListsSection({ lists }: { lists: ListProgress[] }) {
	if (!lists.length) return null;
	return (
		<section>
			<div className="mb-4 flex items-baseline gap-3">
				<SectionHead title="Your lists" hint="Working through in order" />
				<Link
					to="/lists"
					className="ml-auto text-[13px] underline"
					style={{ color: "var(--text-2)" }}
				>
					All lists
				</Link>
			</div>
			<div className="grid gap-3 sm:grid-cols-2">
				{lists.map((l) => (
					<Link
						key={l.id}
						to="/lists/$id"
						params={{ id: String(l.id) }}
						className="panel block p-4"
					>
						<div className="flex items-baseline gap-3">
							<span className="truncate text-[15px] font-medium">{l.name}</span>
							<span
								className="tnum ml-auto shrink-0 text-[12px]"
								style={{ color: "var(--text-3)" }}
							>
								{l.watched}/{l.total}
							</span>
						</div>
						<div className="episode-track mt-2">
							<div
								className="episode-fill"
								style={{
									width: `${(l.watched / Math.max(1, l.total)) * 100}%`,
								}}
							/>
						</div>
						{l.next && (
							<div
								className="mt-2 truncate text-[13px]"
								style={{ color: "var(--text-2)" }}
							>
								Next: {l.next.name}
								{l.next.year ? ` (${l.next.year})` : ""}
							</div>
						)}
					</Link>
				))}
			</div>
		</section>
	);
}

function ComingSoon({ shows }: { shows: LibraryShow[] }) {
	if (!shows.length) return null;
	return (
		<section>
			<div className="mb-3 flex items-baseline gap-3">
				<SectionHead
					title="Coming soon"
					count={shows.length}
					hint="Next episode airs within 30 days"
				/>
			</div>
			<ul className="panel">
				{shows.map((s, i) => (
					<li
						key={s.simklId}
						className="flex items-center gap-3 px-4 py-2.5"
						style={i ? { borderTop: "1px solid var(--hairline)" } : undefined}
					>
						<span
							className="tnum w-24 shrink-0 text-[12px]"
							style={{ color: "var(--accent-deep)" }}
						>
							{untilDate(s.nextAirDate)}
						</span>
						<a
							href={s.simklUrl}
							target="_blank"
							rel="noreferrer"
							className="truncate text-[14px] hover:underline"
						>
							{s.title}
						</a>
						<span
							className="tnum ml-auto shrink-0 text-[12px]"
							style={{ color: "var(--text-3)" }}
						>
							{s.behind ? `${s.behind} behind` : "Caught up"}
						</span>
					</li>
				))}
			</ul>
		</section>
	);
}

function ShowShelf({
	title,
	hint,
	shows,
	collapsed = false,
}: {
	title: string;
	hint: string;
	shows: LibraryShow[];
	collapsed?: boolean;
}) {
	if (!shows.length) return null;
	const Wrapper = collapsed ? "details" : "section";
	const Heading = collapsed ? "summary" : "div";
	return (
		<Wrapper>
			<Heading className="mb-4 flex cursor-pointer items-baseline gap-3">
				<SectionHead title={title} count={shows.length} hint={hint} />
			</Heading>
			<div className="grid grid-cols-4 gap-x-3 gap-y-5 sm:grid-cols-6 md:grid-cols-7 lg:grid-cols-8">
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
							progress={s.aired ? s.watched / s.aired : undefined}
							dim
						/>
						<div className="mt-1.5 truncate text-[12px] font-medium">
							{s.title}
						</div>
						<div
							className="tnum truncate text-[11px]"
							style={{ color: "var(--text-3)" }}
						>
							{s.behind} to go · {relativeTime(s.lastWatchedAt)}
						</div>
					</a>
				))}
			</div>
		</Wrapper>
	);
}
