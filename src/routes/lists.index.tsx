import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { DrawablyButton } from "drawably/react";
import { useState } from "react";
import { relativeTime } from "../lib/format.ts";
import { addList, getLists, removeList } from "../server/fns.ts";
import type { ListProgress } from "../server/lists.ts";

export const Route = createFileRoute("/lists/")({
	component: ListsPage,
	loader: () => getLists(),
});

type BtnState = "idle" | "loading" | "success" | "error";

const ORIGIN: Record<string, string> = {
	own: "Yours",
	liked: "Liked",
	added: "Added",
};

function ListsPage() {
	const lists = Route.useLoaderData();
	const router = useRouter();
	const [url, setUrl] = useState("");
	const [state, setState] = useState<BtnState>("idle");
	const [error, setError] = useState<string | null>(null);

	const started = lists.filter((l) => l.watched > 0);
	const notStarted = lists.filter((l) => l.watched === 0);

	async function add(e: React.FormEvent) {
		e.preventDefault();
		if (!url.trim()) return;
		setState("loading");
		setError(null);
		const res = await addList({ data: { url } });
		if (res.ok) {
			setState("success");
			setUrl("");
			await router.invalidate();
		} else {
			setState("error");
			setError(res.error);
		}
		setTimeout(() => setState("idle"), 2000);
	}

	return (
		<div className="space-y-10">
			<section>
				<h1 className="text-[22px] font-semibold">Lists</h1>
				<p
					className="mt-1 max-w-prose text-[14px]"
					style={{ color: "var(--text-2)" }}
				>
					Letterboxd lists you follow: your own and the ones you liked (from
					your export), plus any you add here. Couch shows how far through each
					you are and what's next. Lists are re-read weekly; use Re-read on a
					list for changes sooner.
				</p>
				<form onSubmit={add} className="mt-4 flex flex-wrap gap-2">
					<input
						className="field h-9 min-w-0 flex-1 px-3 text-[14px] sm:max-w-md"
						placeholder="Paste a Letterboxd list link"
						value={url}
						onChange={(e) => setUrl(e.target.value)}
					/>
					<DrawablyButton
						seed={601}
						variant="solid"
						state={state}
						type="submit"
					>
						Follow list
					</DrawablyButton>
				</form>
				{state === "loading" && (
					<p className="mt-2 text-[12px]" style={{ color: "var(--text-3)" }}>
						Reading the list from Letterboxd; long lists take a little while.
					</p>
				)}
				{error && (
					<p
						className="mt-2 text-[13px]"
						style={{ color: "var(--drawably-error)" }}
					>
						{error}
					</p>
				)}
			</section>

			<ListGroup title="In progress" lists={started} />
			<ListGroup title="Not started" lists={notStarted} />
		</div>
	);
}

function ListGroup({ title, lists }: { title: string; lists: ListProgress[] }) {
	const router = useRouter();
	if (!lists.length) return null;

	async function unfollow(id: number) {
		await removeList({ data: { id } });
		await router.invalidate();
	}

	return (
		<section>
			<h2 className="mb-3 text-[17px] font-semibold">{title}</h2>
			<div className="grid gap-3 sm:grid-cols-2">
				{lists.map((l) => (
					<div key={l.id} className="panel p-4">
						<div className="flex items-baseline gap-3">
							<Link
								to="/lists/$id"
								params={{ id: String(l.id) }}
								className="truncate text-[15px] font-medium hover:underline"
							>
								{l.name}
							</Link>
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
						<div
							className="mt-2 flex items-center gap-2 text-[12px]"
							style={{ color: "var(--text-3)" }}
						>
							<span className="chip">{ORIGIN[l.origin] ?? l.origin}</span>
							{(l.pinned || l.ranked) && (
								<span
									className={`chip ${l.pinned ? "chip-accent" : ""}`}
									title={
										l.pinned
											? "You're working through this: its next film is in Up next"
											: "A numbered watch order: its next film shows in Up next while you're watching from it"
									}
								>
									{l.pinned ? "Working through" : "Ranked"}
								</span>
							)}
							{l.owner && <span>by {l.owner}</span>}
							<span>· read {relativeTime(l.fetchedAt)}</span>
							<button
								type="button"
								onClick={() => unfollow(l.id)}
								className="ml-auto underline"
								title="Stop following this list in Couch (doesn't change Letterboxd)"
							>
								Unfollow
							</button>
						</div>
						{l.error && (
							<p
								className="mt-2 text-[12px]"
								style={{ color: "var(--drawably-error)" }}
							>
								{l.error}
							</p>
						)}
					</div>
				))}
			</div>
		</section>
	);
}
