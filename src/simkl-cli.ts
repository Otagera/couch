import { getConfig } from "./app.config";
import { CacheService } from "./services/cache.service";
import { SimklService, type SimklShow } from "./services/simkl.service";

const USAGE = `Usage: npm run simkl -- <command>

  login    Connect your Simkl account (enter a code at simkl.com/pin)
  sync     Pull your TV shows from Simkl (add --force to skip the change check)
  shows    Summarise the shows synced so far
  logout   Forget the stored Simkl login`;

async function main() {
	const [command, ...flags] = process.argv.slice(2);
	if (!command || command === "help") {
		console.log(USAGE);
		return;
	}

	const clientId = getConfig().simkl.clientId;
	if (!clientId) {
		console.error(
			"SIMKL_CLIENT_ID is missing from .env. Create an app (type: TV/devices/CLI) at https://simkl.com/settings/developer/ and paste its client ID.",
		);
		process.exit(1);
	}

	const cache = new CacheService();
	await cache.init();
	const simkl = new SimklService(clientId, cache);

	switch (command) {
		case "login": {
			await simkl.login(({ userCode, verificationUrl }) => {
				console.log(`\nOpen ${verificationUrl}`);
				console.log(`and enter the code: ${userCode}\n`);
				console.log("Waiting for approval...");
			});
			console.log("✅ Connected to Simkl.");
			break;
		}
		case "sync": {
			const { shows, changed } = await simkl.syncShows(
				flags.includes("--force"),
			);
			console.log(
				changed
					? `✅ Synced ${shows.length} TV shows from Simkl.`
					: `No changes on Simkl since the last sync (${shows.length} shows cached).`,
			);
			summarise(shows);
			break;
		}
		case "shows": {
			summarise(await simkl.getCachedShows());
			break;
		}
		case "logout": {
			await simkl.logout();
			console.log("Simkl login removed.");
			break;
		}
		default:
			console.log(USAGE);
			process.exit(1);
	}
	process.exit(0);
}

function summarise(shows: SimklShow[]) {
	if (shows.length === 0) {
		console.log("No shows synced yet. Run: npm run simkl -- sync");
		return;
	}
	const byStatus = new Map<string, number>();
	for (const s of shows)
		byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);
	console.log(
		"\nBy status:",
		[...byStatus].map(([k, v]) => `${k} ${v}`).join(", "),
	);

	const rated = shows.filter((s) => s.userRating !== null);
	console.log(
		`Rated: ${rated.length}, missing TMDB id: ${shows.filter((s) => !s.tmdbId).length}`,
	);

	const watching = shows
		.filter((s) => s.status === "watching")
		.sort((a, b) =>
			(b.lastWatchedAt ?? "").localeCompare(a.lastWatchedAt ?? ""),
		)
		.slice(0, 10);
	if (watching.length) {
		console.log("\nCurrently watching:");
		for (const s of watching)
			console.log(
				`  ${s.title} (${s.year ?? "?"}): ${s.watchedEpisodes}/${s.totalEpisodes}, next ${s.nextToWatch ?? "-"}`,
			);
	}

	const top = [...rated]
		.sort((a, b) => (b.userRating ?? 0) - (a.userRating ?? 0))
		.slice(0, 10);
	if (top.length) {
		console.log("\nTop rated:");
		for (const s of top)
			console.log(`  ${s.userRating}/10  ${s.title} (${s.year ?? "?"})`);
	}
	console.log("\nData from Simkl (https://simkl.com)");
}

main().catch((error) => {
	console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
