/**
 * Couch maintenance CLI. Runs straight from TypeScript:
 *
 *   npm run cli -- <command>
 *
 * Imports only node: builtins and sibling modules, so it also runs inside
 * the production image with no node_modules (docker exec ... node src/server/cli.ts).
 */

import { listPasskeys, resetAuth } from "./auth/store.ts";
import { config } from "./config.ts";
import { closeDb } from "./db/index.ts";
import { filmStats } from "./films.ts";
import { libraryStats, upNext } from "./library.ts";
import { createLogger, flushLogs } from "./log.ts";
import {
	forgetDrive,
	importDrive,
	listDrives,
	scanDirectory,
} from "./media/index.ts";
import { dryRunPicks, latestPicks, runPicks } from "./picks.ts";
import { isLoggedIn, login, logout } from "./simkl.ts";
import { syncAll } from "./sync.ts";
import { buildProfile, getProfile } from "./taste.ts";

const USAGE = `Couch: what to watch next

  login            Connect Simkl (enter a code at simkl.com/pin)
  logout           Forget the Simkl login
  sync [--force]   Pull your TV library from Simkl and refresh TMDB details
  up-next          Continue watching, new episodes, coming soon, paused shows
  taste [--force]  Show (or rebuild) your taste profile
  films            Film history stats (Letterboxd export + diary RSS)
  picks [--movies] Show the latest TV (or film) picks
        --new      Generate new picks (one OpenRouter call)
        --dry-run  Print exactly what would be sent to the model; no call
        --model X  Use OpenRouter model X for this run (compare models)
  status           What is configured and synced
  scan <folder>    Find video files on a drive and mark what you have locally
        --dry-run  Only show what each file was recognised as; saves nothing
        --drive N  Name for this drive (default: the folder name)
        --push URL Send to a deployed Couch (needs COUCH_SCANNER_TOKEN)
  drives           Scanned drives; "drives forget NAME" removes one
  passkeys         List passkeys; "passkeys reset" removes all passkeys and
                   sessions so the setup code can register a new one`;

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2);
	const flag = (f: string) => rest.includes(f);

	switch (command) {
		case "login": {
			await login((l) => {
				console.log(
					`\nOpen ${l.verificationUrl}\nand enter the code: ${l.userCode}\n`,
				);
				console.log("Waiting for approval...");
			});
			console.log("Connected to Simkl. Next: npm run cli -- sync");
			return;
		}
		case "logout":
			logout();
			console.log("Simkl login removed.");
			return;

		case "sync": {
			const r = await syncAll(flag("--force"));
			if (r.tv) {
				console.log(
					r.tv.changed
						? `TV: synced ${r.tv.shows} shows from Simkl.`
						: `TV: no changes on Simkl (${r.tv.shows} shows).`,
					libraryStats(),
				);
			} else console.log("TV: Simkl not connected (npm run cli -- login).");
			if (r.films) {
				console.log(
					`Films: ${r.films.csvImported ? "imported the Letterboxd export, " : ""}${r.films.rssEntries} diary entries from RSS, ${r.films.matched} newly matched to TMDB.`,
					filmStats(),
				);
			}
			if (r.lists)
				console.log(
					`Lists: ${r.lists.added} newly followed, ${r.lists.refreshed} refreshed, ${r.lists.failed} failed.`,
				);
			for (const e of r.errors) console.log(`Warning: ${e}`);
			return;
		}

		case "up-next": {
			const u = upNext();
			const show = (
				title: string,
				rows: ReturnType<typeof upNext>["paused"],
				fmt: (s: (typeof rows)[number]) => string,
			) => {
				if (!rows.length) return;
				console.log(`\n${title}`);
				for (const s of rows) console.log(`  ${fmt(s)}`);
			};
			show(
				"Continue watching",
				u.continueWatching,
				(s) =>
					`${s.title}: next ${s.nextToWatch ?? "?"} (${s.watched}/${s.aired})`,
			);
			show(
				"New episodes",
				u.newEpisodes,
				(s) => `${s.title}: ${s.behind} unwatched`,
			);
			show(
				"Coming soon",
				u.comingSoon,
				(s) =>
					`${s.nextAirDate}  ${s.title}${s.behind ? ` (${s.behind} behind)` : ""}`,
			);
			const away = (s: (typeof u.paused)[number]) =>
				`${s.title}: ${s.behind} to go, last watched ${s.lastWatchedAt?.slice(0, 10) ?? "?"}`;
			show("Paused", u.paused, away);
			if (u.longBreak.length)
				console.log(
					`\nOn a long break: ${u.longBreak.length} shows (over 6 months)`,
				);
			return;
		}

		case "taste": {
			const { profile, rebuilt } =
				flag("--force") || !getProfile()
					? await buildProfile(true)
					: { profile: getProfile(), rebuilt: false };
			if (profile) {
				console.log(profile.text);
				console.log(
					`\n(${rebuilt ? "built" : "cached"} ${profile.createdAt.slice(0, 10)} by ${profile.model})`,
				);
			}
			return;
		}

		case "films": {
			console.log(filmStats());
			return;
		}

		case "picks": {
			const kind = flag("--movies") ? "movie" : "tv";
			const modelAt = rest.indexOf("--model");
			const model = modelAt >= 0 ? rest[modelAt + 1] : undefined;
			if (flag("--dry-run")) {
				const d = await dryRunPicks(kind, model);
				for (const m of d.messages)
					console.log(`===== ${m.role} =====\n${m.content}\n`);
				console.log(
					`----- ${d.candidates} candidates, ~${d.approxInputTokens} input tokens, model ${d.model}. Nothing was sent.`,
				);
				if (d.profileStale)
					console.log(
						"Note: your history changed since the taste profile was written; a real run rewrites it first (npm run cli -- taste --force to see it).",
					);
				return;
			}
			if (flag("--new")) {
				console.log("Choosing picks (this takes a minute)...");
				const r = await runPicks(kind, model);
				console.log(
					`Done: ${r.candidates} candidates considered${r.costUsd != null ? `, $${r.costUsd.toFixed(3)}` : ""}.`,
				);
			}
			const { picks, createdAt } = latestPicks(kind);
			if (!picks.length) {
				console.log(
					`No picks yet. Run: npm run cli -- picks --new${kind === "movie" ? " --movies" : ""}`,
				);
				return;
			}
			console.log(`\nPicks from ${createdAt?.slice(0, 10)}:\n`);
			for (const p of picks) {
				console.log(
					`${p.rank}. ${p.title}${p.year ? ` (${p.year})` : ""}${p.providers.length ? `  [${p.providers.join(", ")}]` : ""}`,
				);
				console.log(`   ${p.reason}\n`);
			}
			console.log(
				kind === "tv"
					? "TV data from Simkl (simkl.com) and TMDB."
					: "Film data from Letterboxd and TMDB.",
			);
			return;
		}

		case "scan": {
			const folder = rest.find(
				(a, i) =>
					!a.startsWith("--") && !["--drive", "--push"].includes(rest[i - 1]),
			);
			if (!folder) {
				console.log(
					"Usage: npm run cli -- scan /Volumes/MyDrive [--dry-run] [--drive NAME] [--push URL]",
				);
				process.exitCode = 1;
				return;
			}
			const opt = (name: string) => {
				const i = rest.indexOf(name);
				return i >= 0 ? rest[i + 1] : undefined;
			};
			const scan = scanDirectory(folder, opt("--drive"));
			if (flag("--dry-run")) {
				printScan(scan);
				return;
			}
			const push = opt("--push");
			if (push) {
				const token = process.env.COUCH_SCANNER_TOKEN;
				if (!token)
					throw new Error(
						"Set COUCH_SCANNER_TOKEN (create one on the Passkeys page).",
					);
				const res = await fetch(`${push.replace(/\/$/, "")}/api/media/import`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${token}`,
					},
					body: JSON.stringify(scan),
				});
				const body = await res.json();
				if (!res.ok)
					throw new Error(
						`Couch refused the import (${res.status}): ${body.error ?? ""}`,
					);
				printImport(body);
				return;
			}
			printImport(await importDrive(scan));
			return;
		}

		case "drives": {
			if (rest[0] === "forget" && rest[1]) {
				forgetDrive(rest[1]);
				console.log(`Forgot drive "${rest[1]}".`);
				return;
			}
			const drives = listDrives();
			if (!drives.length)
				console.log(
					"No drives scanned yet. Run: npm run cli -- scan /Volumes/MyDrive",
				);
			for (const d of drives)
				console.log(
					`${d.name.padEnd(24)} ${String(d.files).padStart(6)} files  ${d.unmatched} unmatched  scanned ${d.scannedAt.slice(0, 10)}  ${d.root ?? ""}`,
				);
			return;
		}

		case "passkeys": {
			if (rest[0] === "reset") {
				const r = resetAuth();
				console.log(
					`Removed ${r.passkeys} passkeys and ${r.sessions} sessions. Open /login and use the setup code.`,
				);
				return;
			}
			const keys = listPasskeys();
			if (!keys.length) console.log("No passkeys yet.");
			for (const k of keys)
				console.log(
					`${k.name}  added ${k.createdAt.slice(0, 10)}  last used ${k.lastUsedAt?.slice(0, 10) ?? "never"}`,
				);
			return;
		}

		case "status": {
			const yes = (v: unknown) => (v ? "yes" : "no");
			console.log(
				`Simkl client id: ${yes(config.simklClientId)}, logged in: ${yes(config.simklClientId && isLoggedIn())}`,
			);
			console.log(
				`TMDB key: ${yes(config.tmdbApiKey)}, OpenRouter key: ${yes(config.openRouterApiKey)}`,
			);
			console.log(
				`Country: ${config.countryCode}, services: ${config.services.join(", ") || "none"}`,
			);
			console.log(`Database: ${config.dbPath}`);
			console.log("Library:", libraryStats());
			console.log(
				`Letterboxd RSS: ${config.letterboxdUsername ? "yes" : "no"}, films:`,
				filmStats(),
			);
			return;
		}

		default:
			console.log(USAGE);
			if (command && command !== "help") process.exitCode = 1;
	}
}

const log = createLogger("cli");

function printScan(scan: ReturnType<typeof scanDirectory>) {
	const films = new Map<string, number>();
	const shows = new Map<string, Map<number, Set<number>>>();
	const unparsed: string[] = [];
	for (const f of scan.files) {
		const p = f.parsed;
		if (!p) unparsed.push(f.path);
		else if (p.kind === "movie") {
			const k = `${p.title}${p.year ? ` (${p.year})` : ""}`;
			films.set(k, (films.get(k) ?? 0) + 1);
		} else {
			const k = `${p.show}${p.year ? ` (${p.year})` : ""}`;
			const seasons = shows.get(k) ?? new Map<number, Set<number>>();
			const eps = seasons.get(p.season) ?? new Set<number>();
			for (let e = p.episode; e <= p.episodeEnd; e++) eps.add(e);
			seasons.set(p.season, eps);
			shows.set(k, seasons);
		}
	}
	console.log(`Drive "${scan.drive}": ${scan.files.length} video files\n`);
	console.log(`Films (${films.size})`);
	for (const [k, n] of [...films].sort())
		console.log(`  ${k}${n > 1 ? `  [${n} files]` : ""}`);
	console.log(`\nShows (${shows.size})`);
	for (const [k, seasons] of [...shows].sort()) {
		const detail = [...seasons]
			.sort(([a], [b]) => a - b)
			.map(([s, eps]) => `S${s}: ${eps.size}`)
			.join(", ");
		console.log(`  ${k}  ${detail}`);
	}
	if (unparsed.length) {
		console.log(`\nNot recognised (${unparsed.length})`);
		for (const p of unparsed.slice(0, 50)) console.log(`  ${p}`);
		if (unparsed.length > 50)
			console.log(`  ...and ${unparsed.length - 50} more`);
	}
	console.log(
		"\nNothing was saved (dry run). If names look wrong, tell me the pattern and I'll adjust the parser.",
	);
}

function printImport(r: Awaited<ReturnType<typeof importDrive>>) {
	console.log(
		`Drive "${r.drive}": ${r.files} files (${r.movies} films, ${r.episodes} episodes across ${r.shows} shows), ${r.unparsed} not recognised.`,
	);
	if (r.unmatched.length) {
		console.log(`Not found on TMDB (${r.unmatched.length}):`);
		for (const u of r.unmatched.slice(0, 30))
			console.log(`  [${u.kind}] ${u.title}${u.year ? ` (${u.year})` : ""}`);
	}
}

main()
	.catch((error) => {
		log.error("CLI_COMMAND_FAILED", { command: process.argv[2] }, error);
		console.error(
			`Error: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	})
	.finally(async () => {
		closeDb();
		await flushLogs();
	});
