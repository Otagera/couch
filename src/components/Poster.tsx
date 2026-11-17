import { DrawablyCard } from "drawably/react";

/**
 * A show's poster, borrowing the comics cover language: a real poster when
 * TMDB has one, a hand-drawn card when it does not. `dim` steps a poster
 * back (used for shows that are not on the viewer's services).
 */
export function Poster({
	title,
	src,
	subtitle,
	progress,
	dim = false,
}: {
	title: string;
	src: string | null;
	subtitle?: string | null;
	/** 0-1: episodes watched. Drawn as the sea line under the poster. */
	progress?: number;
	dim?: boolean;
}) {
	return (
		<div className={`cover ${dim ? "cover-remote" : ""}`}>
			{src ? (
				<img
					src={src}
					alt=""
					loading="lazy"
					decoding="async"
					className="h-full w-full object-cover"
				/>
			) : (
				<DrawablyCard
					seed={seedFrom(title)}
					boil={0}
					roughness={1.1}
					className="h-full w-full"
				>
					<div className="sketch-tile">
						<div
							className="pen text-[15px] leading-tight"
							style={{
								color: "var(--text)",
								display: "-webkit-box",
								WebkitLineClamp: 5,
								WebkitBoxOrient: "vertical",
								overflow: "hidden",
							}}
						>
							{title}
						</div>
						{subtitle && (
							<div
								className="pen text-[12px]"
								style={{ color: "var(--text-2)" }}
							>
								{subtitle}
							</div>
						)}
					</div>
				</DrawablyCard>
			)}
			{progress !== undefined && progress > 0 && progress < 1 && (
				<div className="absolute inset-x-0 bottom-0 p-1.5">
					<div
						className="progress-line"
						style={{ width: `${progress * 100}%` }}
					/>
				</div>
			)}
		</div>
	);
}

/** Stable seed per title, so a show's sketch never re-rolls. */
export function seedFrom(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}
