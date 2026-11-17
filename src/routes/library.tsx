import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Poster } from "../components/Poster.tsx";
import { getLibrary } from "../server/fns.ts";

const SHELVES = [
	["all", "All"],
	["in-progress", "In progress"],
	["want", "Want to watch"],
	["finished", "Finished"],
	["paused", "Paused"],
	["dropped", "Dropped"],
	["on-drive", "On my drives"],
] as const;
type Shelf = (typeof SHELVES)[number][0];

const KINDS = [
	["all", "TV & films"],
	["tv", "TV"],
	["film", "Films"],
] as const;
type Kind = (typeof KINDS)[number][0];

interface Search {
	shelf?: Shelf;
	kind?: Kind;
}

export const Route = createFileRoute("/library")({
	validateSearch: (s: Record<string, unknown>): Search => ({
		...(SHELVES.some(([k]) => k === s.shelf && k !== "all")
			? { shelf: s.shelf as Shelf }
			: {}),
		...(s.kind === "tv" || s.kind === "film" ? { kind: s.kind } : {}),
	}),
	loaderDeps: ({ search }) => ({
		shelf: search.shelf ?? "all",
		kind: search.kind ?? "all",
	}),
	loader: ({ deps }) => getLibrary({ data: deps }),
	component: LibraryPage,
});

type Sort = "recent" | "rating" | "title";

function LibraryPage() {
	const { items, counts } = Route.useLoaderData();
	const search = Route.useSearch();
	const shelf: Shelf = search.shelf ?? "all";
	const kind: Kind = search.kind ?? "all";
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<Sort>("recent");

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		const rows = q
			? items.filter((i) => i.title.toLowerCase().includes(q))
			: [...items];
		if (sort === "rating")
			rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
		else if (sort === "recent")
			rows.sort((a, b) => (b.activeAt ?? "").localeCompare(a.activeAt ?? ""));
		else rows.sort((a, b) => a.title.localeCompare(b.title));
		return rows;
	}, [items, query, sort]);

	// Keep the other filter when switching one; omit defaults from the URL.
	const to = (next: Partial<Search>): Search => {
		const s = { shelf, kind, ...next };
		return {
			...(s.shelf !== "all" ? { shelf: s.shelf } : {}),
			...(s.kind !== "all" ? { kind: s.kind } : {}),
		};
	};

	return (
		<div>
			<div
				className="mb-3 flex flex-wrap gap-1"
				role="tablist"
				aria-label="Media"
			>
				{KINDS.map(([k, label]) => (
					<Link
						key={k}
						to="/library"
						search={to({ kind: k })}
						className="tab"
						role="tab"
						aria-selected={k === kind}
					>
						{label}
					</Link>
				))}
			</div>
			<div
				className="mb-5 flex flex-wrap gap-1"
				role="tablist"
				aria-label="Shelf"
			>
				{SHELVES.map(([s, label]) =>
					counts[s] || s === "all" ? (
						<Link
							key={s}
							to="/library"
							search={to({ shelf: s })}
							className="tab"
							role="tab"
							aria-selected={s === shelf}
						>
							{label}
							<span
								className="tnum ml-1.5 text-[11px]"
								style={{ color: "var(--text-3)" }}
							>
								{counts[s]}
							</span>
						</Link>
					) : null,
				)}
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
					<option value="recent">Recent activity</option>
					<option value="rating">Your rating</option>
					<option value="title">Title</option>
				</select>
			</div>

			{visible.length === 0 ? (
				<p className="text-[14px]" style={{ color: "var(--text-3)" }}>
					Nothing here.
				</p>
			) : (
				<div className="grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
					{visible.slice(0, 600).map((i) => (
						<a
							key={i.key}
							href={i.url}
							target="_blank"
							rel="noreferrer"
							className="group block"
						>
							<div className="relative">
								<Poster
									title={i.title}
									src={i.poster}
									subtitle={i.year ? String(i.year) : null}
									progress={i.progress}
									dim={i.shelf === "dropped"}
								/>
								{i.local && (
									<span
										className="drive-tag"
										title={`On your drive: ${i.local}`}
									>
										Drive
									</span>
								)}
								{kind === "all" && (
									<span className={`kind-tag kind-${i.kind}`}>
										{i.kind === "tv" ? "TV" : "Film"}
									</span>
								)}
							</div>
							<div className="mt-2 truncate text-[14px] font-medium">
								{i.title}
							</div>
							<div
								className="tnum flex justify-between gap-2 text-[11px]"
								style={{ color: "var(--text-3)" }}
							>
								<span className="truncate">
									{shelf === "on-drive" && i.local
										? i.local
										: (i.note ?? i.year)}
								</span>
								{i.rating && (
									<span
										className="shrink-0"
										style={{ color: "var(--accent-deep)" }}
									>
										{i.rating}
									</span>
								)}
							</div>
						</a>
					))}
				</div>
			)}
			{visible.length > 600 && (
				<p className="mt-4 text-[13px]" style={{ color: "var(--text-3)" }}>
					Showing 600 of {visible.length}. Filter or pick a shelf to narrow it
					down.
				</p>
			)}
		</div>
	);
}
