/**
 * Background sync, in-process. Every COUCH_SYNC_HOURS (default 6) the server
 * pulls Simkl and refreshes TMDB details, so "Up next" is current without a
 * click and without host cron.
 *
 * Cheap on Simkl's 500-calls-a-day quota: an unchanged library costs one
 * /sync/activities call per run. Picks are never generated here; they cost
 * money and run only when asked.
 */

import { definePlugin } from "nitro";
import { createLogger, flushLogs } from "./log.ts";
import { syncAll } from "./sync.ts";

const log = createLogger("scheduler");
const hours = Number(process.env.COUCH_SYNC_HOURS ?? 6);

export default definePlugin((nitroApp) => {
	if (!(hours > 0)) return;
	let running = false;

	const tick = async () => {
		if (running) return;
		running = true;
		try {
			await syncAll();
		} catch {
			// syncAll already logged SYNC_FAILED; try again next interval.
		} finally {
			running = false;
		}
	};

	// First run shortly after boot (a redeploy should not wait 6 hours).
	const first = setTimeout(tick, 60_000);
	const every = setInterval(tick, hours * 3_600_000);
	first.unref?.();
	every.unref?.();
	log.info("SCHEDULER_STARTED", { everyHours: hours });

	nitroApp.hooks.hook("close", async () => {
		clearTimeout(first);
		clearInterval(every);
		await flushLogs();
	});
});
