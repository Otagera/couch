/**
 * Couch maintenance CLI. Runs straight from TypeScript:
 *
 *   npm run cli -- <command>
 *
 * Imports only node: builtins and sibling modules, so it also runs inside
 * the production image with no node_modules (docker exec ... node src/server/cli.ts).
 */

import { config } from "./config.ts";
import { closeDb } from "./db/index.ts";
import { libraryStats, upNext } from "./library.ts";
import { createLogger, flushLogs } from "./log.ts";
import { latestPicks, runPicks } from "./picks.ts";
import { isLoggedIn, login, logout } from "./simkl.ts";
import { syncAll } from "./sync.ts";
import { buildProfile, getProfile } from "./taste.ts";

const USAGE = `Couch: what to watch next

  login            Connect Simkl (enter a code at simkl.com/pin)
  logout           Forget the Simkl login
  sync [--force]   Pull your TV library from Simkl and refresh TMDB details
  up-next          Continue watching, stalled shows, new episodes, coming soon
  taste [--force]  Show (or rebuild) your taste profile
  picks [--new]    Show the latest picks, or generate new ones (uses OpenRouter)
  status           What is configured and synced`;

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
			console.log(
				r.changed
					? `Synced ${r.shows} shows from Simkl.`
					: `No changes on Simkl (${r.shows} shows). Refreshed TMDB details for ${r.detailsRefreshed}.`,
			);
			console.log(libraryStats());
			return;
		}

		case "up-next": {
			const u = upNext();
			const show = (
				title: string,
				rows: ReturnType<typeof upNext>["stalled"],
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
					`${s.title}: next ${s.nextToWatch ?? "?"} (${s.watched}/${s.total})`,
			);
			show(
				"New episodes",
				u.newEpisodes,
				(s) => `${s.title}: ${s.total - s.watched} unwatched`,
			);
			show("Coming soon", u.comingSoon, (s) => `${s.nextAirDate}  ${s.title}`);
			show(
				"Stalled",
				u.stalled,
				(s) =>
					`${s.title}: last watched ${s.lastWatchedAt?.slice(0, 10) ?? "?"}, at ${s.lastWatched ?? "?"}`,
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

		case "picks": {
			if (flag("--new")) {
				console.log("Choosing picks (this takes a minute)...");
				const r = await runPicks();
				console.log(
					`Done: ${r.candidates} candidates considered${r.costUsd != null ? `, $${r.costUsd.toFixed(3)}` : ""}.`,
				);
			}
			const { picks, createdAt } = latestPicks();
			if (!picks.length) {
				console.log("No picks yet. Run: npm run cli -- picks --new");
				return;
			}
			console.log(`\nPicks from ${createdAt?.slice(0, 10)}:\n`);
			for (const p of picks) {
				console.log(
					`${p.rank}. ${p.title}${p.year ? ` (${p.year})` : ""}${p.providers.length ? `  [${p.providers.join(", ")}]` : ""}`,
				);
				console.log(`   ${p.reason}\n`);
			}
			console.log("TV data from Simkl (simkl.com) and TMDB.");
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
			return;
		}

		default:
			console.log(USAGE);
			if (command && command !== "help") process.exitCode = 1;
	}
}

const log = createLogger("cli");

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
