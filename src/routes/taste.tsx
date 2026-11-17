import { createFileRoute, useRouter } from "@tanstack/react-router";
import { DrawablyButton } from "drawably/react";
import { useState } from "react";
import { relativeTime } from "../lib/format.ts";
import { getTaste, rebuildTaste, saveNotes } from "../server/fns.ts";

export const Route = createFileRoute("/taste")({
	component: TastePage,
	loader: () => getTaste(),
});

type BtnState = "idle" | "loading" | "success" | "error";

function TastePage() {
	const { profile, notes: savedNotes } = Route.useLoaderData();
	const router = useRouter();
	const [notes, setNotes] = useState(savedNotes);
	const [saveState, setSaveState] = useState<BtnState>("idle");
	const [rebuildState, setRebuildState] = useState<BtnState>("idle");
	const [error, setError] = useState<string | null>(null);

	async function save() {
		setSaveState("loading");
		await saveNotes({ data: { notes } });
		setSaveState("success");
		setTimeout(() => setSaveState("idle"), 2000);
	}

	async function rebuild() {
		setRebuildState("loading");
		setError(null);
		if (notes !== savedNotes) await saveNotes({ data: { notes } });
		const res = await rebuildTaste();
		if (res.ok) {
			setRebuildState("success");
			await router.invalidate();
		} else {
			setRebuildState("error");
			setError(res.error);
		}
		setTimeout(() => setRebuildState("idle"), 2500);
	}

	return (
		<div className="grid gap-8 lg:grid-cols-[1fr_340px]">
			<section className="panel p-6">
				<div className="flex flex-wrap items-baseline gap-3">
					<h1 className="text-[22px] font-semibold">Your taste</h1>
					{profile && (
						<span className="text-[12px]" style={{ color: "var(--text-3)" }}>
							Written {relativeTime(profile.createdAt)} by {profile.model}
						</span>
					)}
				</div>
				{profile ? (
					<div className="prose-taste mt-2">
						<Markdownish text={profile.text} />
					</div>
				) : (
					<p className="mt-3 text-[14px]" style={{ color: "var(--text-2)" }}>
						No profile yet. It is written from your Simkl shows, your Letterboxd
						ratings and reviews, and your feedback on picks. Getting picks
						builds it automatically.
					</p>
				)}
				{error && (
					<p
						className="mt-4 text-[14px]"
						style={{ color: "var(--drawably-error)" }}
					>
						{error}
					</p>
				)}
			</section>

			<aside className="space-y-3">
				<h2 className="text-[15px] font-semibold">Set it straight</h2>
				<p className="text-[13px]" style={{ color: "var(--text-2)" }}>
					Anything the profile gets wrong, or anything it cannot know. These
					notes override what it infers from your history.
				</p>
				<textarea
					className="field min-h-40 w-full p-3 text-[14px]"
					placeholder="e.g. I'm done with true crime. I love a good heist. Nothing over 3 seasons unless it's exceptional."
					value={notes}
					onChange={(e) => setNotes(e.target.value)}
				/>
				<div className="flex gap-2">
					<DrawablyButton
						seed={501}
						state={saveState}
						onClick={save}
						disabled={notes === savedNotes}
					>
						Save notes
					</DrawablyButton>
					<DrawablyButton
						seed={502}
						variant="solid"
						state={rebuildState}
						onClick={rebuild}
					>
						Rewrite profile
					</DrawablyButton>
				</div>
			</aside>
		</div>
	);
}

/** Just enough markdown for the profile: ## headings, bullets, paragraphs, **bold**. */
function Markdownish({ text }: { text: string }) {
	const blocks: React.ReactNode[] = [];
	let list: string[] = [];
	const flush = () => {
		if (list.length) {
			blocks.push(
				<ul key={blocks.length}>
					{list.map((li) => (
						<li key={li}>{inline(li)}</li>
					))}
				</ul>,
			);
			list = [];
		}
	};
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (/^[-*]\s+/.test(line)) {
			list.push(line.replace(/^[-*]\s+/, ""));
			continue;
		}
		flush();
		if (!line) continue;
		if (/^#{1,6}\s/.test(line))
			blocks.push(<h2 key={blocks.length}>{line.replace(/^#+\s*/, "")}</h2>);
		else blocks.push(<p key={blocks.length}>{inline(line)}</p>);
	}
	flush();
	return <>{blocks}</>;
}

function inline(s: string): React.ReactNode {
	return s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
		part.startsWith("**") && part.endsWith("**") ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: static split of one string
			<strong key={i} style={{ color: "var(--text)" }}>
				{part.slice(2, -2)}
			</strong>
		) : (
			part
		),
	);
}
