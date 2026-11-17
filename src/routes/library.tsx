import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Poster } from "../components/Poster.tsx";
import { STATUS_LABEL } from "../lib/format.ts";
import { getLibrary } from "../server/fns.ts";

const TABS = [
	"all",
	"watching",
	"plantowatch",
	"hold",
	"completed",
	"dropped",
] as const;
type Tab = (typeof TABS)[number];

export const Route = createFileRoute("/library")({
	validateSearch: (s: Record<string, unknown>): { status: Tab } => ({
		status: TABS.includes(s.status as Tab) ? (s.status as Tab) : "all",
	}),
	loaderDeps: ({ search }) => ({ status: search.status }),
	loader: ({ deps }) =>
		getLibrary({
			data: { status: deps.status === "all" ? undefined : deps.status },
		}),
	component: LibraryPage,
});

type Sort = "title" | "rating" | "recent";

function LibraryPage() {
	const { shows, stats } = Route.useLoaderData();
	const { status } = Route.useSearch();
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<Sort>("recent");

	const total = Object.values(stats).reduce((a, b) => a + (b ?? 0), 0);

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		const rows = q
			? shows.filter((s) => s.title.toLowerCase().includes(q))
			: [...shows];
		if (sort === "rating")
			rows.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
		if (sort === "recent")
			rows.sort((a, b) =>
				(b.lastWatchedAt ?? "").localeCompare(a.lastWatchedAt ?? ""),
			);
		return rows;
	}, [shows, query, sort]);

	return (
		<div>
			<div className="mb-5 flex flex-wrap items-center gap-2">
				{TABS.map((t) => (
					<Link
						key={t}
						to="/library"
						search={{ status: t }}
						className="nav-link"
						data-status={t === status ? "active" : undefined}
					>
						{t === "all" ? "All" : STATUS_LABEL[t]}
						<span
							className="tnum ml-1.5 text-[11px]"
							style={{ color: "var(--text-3)" }}
						>
							{t === "all" ? total : (stats[t] ?? 0)}
						</span>
					</Link>
				))}
			</div>
			<div className="mb-6 flex flex-wrap gap-3">
				<input
					className="field h-9 min-w-0 flex-1 px-3 text-[14px] sm:max-w-xs"
					placeholder="Filter by title"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
				<select
					className="field h-9 px-2 text-[14px]"
					value={sort}
					onChange={(e) => setSort(e.target.value as Sort)}
					aria-label="Sort"
				>
					<option value="recent">Recently watched</option>
					<option value="rating">Your rating</option>
					<option value="title">Title</option>
				</select>
			</div>

			{visible.length === 0 ? (
				<p className="text-[14px]" style={{ color: "var(--text-3)" }}>
					No shows here.
				</p>
			) : (
				<div className="grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
					{visible.map((s) => (
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
								progress={s.aired ? s.watched / s.aired : undefined}
								dim={s.status === "dropped"}
							/>
							<div className="mt-2 truncate text-[14px] font-medium">
								{s.title}
							</div>
							<div
								className="tnum flex justify-between text-[11px]"
								style={{ color: "var(--text-3)" }}
							>
								<span>
									{status === "all" ? STATUS_LABEL[s.status] : s.year}
								</span>
								{s.rating ? (
									<span style={{ color: "var(--accent-deep)" }}>
										{s.rating}/10
									</span>
								) : null}
							</div>
						</a>
					))}
				</div>
			)}
		</div>
	);
}
