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
	const {
		profile,
		notes: savedNotes,
		films,
		letterboxdImportedAt,
	} = Route.useLoaderData();
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

			<aside className="space-y-8">
				<LetterboxdUpload films={films} importedAt={letterboxdImportedAt} />
				<div className="space-y-3">
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

/** Upload the Letterboxd export zip (Settings > Import & Export on Letterboxd). */
function LetterboxdUpload({
	films,
	importedAt,
}: {
	films: { watched: number; watchlist: number; rated: number };
	importedAt: string | null;
}) {
	const router = useRouter();
	const [state, setState] = useState<BtnState>("idle");
	const [message, setMessage] = useState<string | null>(null);

	async function upload(file: File) {
		setState("loading");
		setMessage(null);
		try {
			const res = await fetch("/api/letterboxd/upload", {
				method: "POST",
				headers: { "Content-Type": "application/zip" },
				body: file,
			});
			const body = (await res.json()) as {
				error?: string;
				stats?: { watched: number; watchlist: number };
			};
			if (!res.ok)
				throw new Error(body.error ?? `Upload failed (${res.status})`);
			setState("success");
			setMessage(
				`Imported: ${body.stats?.watched ?? 0} watched, ${body.stats?.watchlist ?? 0} on your watchlist. Posters and lists are filling in now; this takes a few minutes the first time.`,
			);
			await router.invalidate();
		} catch (e) {
			setState("error");
			setMessage(e instanceof Error ? e.message : String(e));
		}
	}

	return (
		<div className="space-y-2">
			<h2 className="text-[15px] font-semibold">Letterboxd export</h2>
			<p className="text-[13px]" style={{ color: "var(--text-2)" }}>
				{films.watched
					? `${films.watched} watched, ${films.rated} rated, ${films.watchlist} on your watchlist${importedAt ? `. Export imported ${relativeTime(importedAt)}` : ""}.`
					: "No film history yet."}{" "}
				Your diary RSS keeps recent watches current; re-upload now and then for
				ratings, likes and watchlist changes.
			</p>
			<p className="text-[12px]" style={{ color: "var(--text-3)" }}>
				On Letterboxd: Settings → Import &amp; Export → Export your data. Upload
				the .zip as is.
			</p>
			<label className="btn inline-flex h-9 cursor-pointer items-center px-3 text-[14px]">
				{state === "loading" ? "Uploading..." : "Upload export (.zip)"}
				<input
					type="file"
					accept=".zip,application/zip"
					className="sr-only"
					disabled={state === "loading"}
					onChange={(e) => {
						const f = e.target.files?.[0];
						if (f) upload(f);
						e.target.value = "";
					}}
				/>
			</label>
			{message && (
				<p
					className="text-[13px]"
					style={{
						color:
							state === "error" ? "var(--drawably-error)" : "var(--text-2)",
					}}
				>
					{message}
				</p>
			)}
		</div>
	);
}
