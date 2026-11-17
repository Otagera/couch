import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { DrawablyButton } from "drawably/react";
import { useState } from "react";
import { Poster } from "../components/Poster.tsx";
import { relativeTime } from "../lib/format.ts";
import { getListDetail, reloadList } from "../server/fns.ts";

export const Route = createFileRoute("/lists/$id")({
	component: ListPage,
	loader: ({ params }) => getListDetail({ data: { id: Number(params.id) } }),
});

type BtnState = "idle" | "loading" | "success" | "error";

function ListPage() {
	const { list, items } = Route.useLoaderData();
	const router = useRouter();
	const [state, setState] = useState<BtnState>("idle");
	const [showWatched, setShowWatched] = useState(true);

	if (!list) {
		return (
			<p className="text-[14px]" style={{ color: "var(--text-2)" }}>
				List not found.{" "}
				<Link to="/lists" className="underline">
					Back to lists
				</Link>
			</p>
		);
	}

	async function reload() {
		if (!list) return;
		setState("loading");
		const res = await reloadList({ data: { id: list.id } });
		setState(res.ok ? "success" : "error");
		await router.invalidate();
		setTimeout(() => setState("idle"), 2000);
	}

	const nextPos = list.next?.position;
	const visible = showWatched ? items : items.filter((i) => !i.watched);

	return (
		<div>
			<Link
				to="/lists"
				className="text-[13px] underline"
				style={{ color: "var(--text-3)" }}
			>
				All lists
			</Link>
			<div className="mt-2 mb-6 flex flex-wrap items-end gap-4">
				<div className="min-w-0">
					<h1 className="text-[22px] font-semibold">{list.name}</h1>
					<p className="text-[13px]" style={{ color: "var(--text-3)" }}>
						{list.owner && <>by {list.owner} · </>}
						<a
							href={list.url}
							target="_blank"
							rel="noreferrer"
							className="underline"
						>
							on Letterboxd
						</a>{" "}
						· read {relativeTime(list.fetchedAt)}
					</p>
					<div className="mt-3 flex items-center gap-3">
						<div className="episode-track w-48">
							<div
								className="episode-fill"
								style={{
									width: `${(list.watched / Math.max(1, list.total)) * 100}%`,
								}}
							/>
						</div>
						<span
							className="tnum text-[13px]"
							style={{ color: "var(--text-2)" }}
						>
							{list.watched} of {list.total} watched
						</span>
					</div>
				</div>
				<div className="ml-auto flex items-center gap-3">
					<label
						className="flex items-center gap-2 text-[13px]"
						style={{ color: "var(--text-2)" }}
					>
						<input
							type="checkbox"
							checked={showWatched}
							onChange={(e) => setShowWatched(e.target.checked)}
						/>
						Show watched
					</label>
					<DrawablyButton
						seed={701}
						state={state}
						onClick={reload}
						className="text-[13px]"
					>
						Re-read
					</DrawablyButton>
				</div>
			</div>

			<div className="grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8">
				{visible.map((i) => (
					<a
						key={i.position}
						href={`https://letterboxd.com/film/${i.slug}/`}
						target="_blank"
						rel="noreferrer"
						className="group block"
					>
						<div className="relative">
							<Poster
								title={i.name}
								src={i.poster}
								subtitle={i.year ? String(i.year) : null}
								dim={i.watched}
							/>
							{i.position === nextPos && (
								<span className="kind-tag kind-film">Next</span>
							)}
						</div>
						<div className="mt-1.5 flex gap-1.5 text-[12px]">
							<span className="tnum" style={{ color: "var(--text-3)" }}>
								{i.position}.
							</span>
							<span className="truncate font-medium">{i.name}</span>
						</div>
						<div
							className="tnum text-[11px]"
							style={{
								color: i.watched ? "var(--accent-deep)" : "var(--text-3)",
							}}
						>
							{i.watched ? "Watched" : i.year}
						</div>
					</a>
				))}
			</div>
		</div>
	);
}
