import {
	createRootRoute,
	HeadContent,
	Link,
	Outlet,
	Scripts,
} from "@tanstack/react-router";
import { SyncButton } from "../components/SyncButton.tsx";
import { ThemeToggle } from "../components/ThemeToggle.tsx";
import { getStatus } from "../server/fns.ts";
import appCss from "../styles.css?url";

/** Applied before first paint, so a dark-theme user never sees a light flash. */
const themeInit = `(function(){try{var t=localStorage.getItem('couch-theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}})()`;

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: "Couch" },
			{ name: "description", content: "What to watch next" },
			{ name: "theme-color", content: "#12968d" },
		],
		links: [
			{ rel: "preconnect", href: "https://fonts.googleapis.com" },
			{
				rel: "preconnect",
				href: "https://fonts.gstatic.com",
				crossOrigin: "anonymous",
			},
			{
				rel: "stylesheet",
				href: "https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap",
			},
			{ rel: "stylesheet", href: appCss },
		],
	}),
	loader: () => getStatus(),
	shellComponent: RootDocument,
	component: Layout,
});

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<head>
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: static pre-paint theme script */}
				<script dangerouslySetInnerHTML={{ __html: themeInit }} />
				<HeadContent />
			</head>
			<body>
				{children}
				<Scripts />
			</body>
		</html>
	);
}

const NAV = [
	{ to: "/", label: "Up next" },
	{ to: "/picks", label: "Picks" },
	{ to: "/library", label: "Library" },
	{ to: "/taste", label: "Taste" },
] as const;

function Layout() {
	const status = Route.useLoaderData();
	return (
		<div className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
			<header className="flex flex-wrap items-center gap-x-6 gap-y-3 py-5">
				<Link
					to="/"
					className="pen text-[26px] leading-none"
					style={{ color: "var(--text)" }}
				>
					Couch
				</Link>
				<nav className="order-3 -mx-1 flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto">
					{NAV.map((n) => (
						<Link
							key={n.to}
							to={n.to}
							className="nav-link whitespace-nowrap"
							activeOptions={{ exact: n.to === "/" }}
						>
							{n.label}
						</Link>
					))}
				</nav>
				<div className="ml-auto flex items-center gap-2">
					{status.simklConnected && (
						<SyncButton lastSync={status.lastSync?.finishedAt ?? null} />
					)}
					<ThemeToggle />
				</div>
			</header>
			<main>
				<Outlet />
			</main>
			<footer className="mt-16 text-[12px]" style={{ color: "var(--text-3)" }}>
				TV data from{" "}
				<a
					href="https://simkl.com"
					className="underline"
					target="_blank"
					rel="noreferrer"
				>
					Simkl
				</a>{" "}
				and{" "}
				<a
					href="https://www.themoviedb.org"
					className="underline"
					target="_blank"
					rel="noreferrer"
				>
					TMDB
				</a>
				. This product uses the TMDB API but is not endorsed or certified by
				TMDB.
			</footer>
		</div>
	);
}
