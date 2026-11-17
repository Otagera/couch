/**
 * Logging: always to the console, and to Chatterbox when configured.
 *
 * Chatterbox's own SDK brings pino and dotenv; this talks to its bulk API
 * directly so server code stays dependency-free and the CLI still runs
 * without node_modules. Logs are batched and sent every few seconds, and
 * `flushLogs()` sends whatever is left (the CLI calls it before exiting).
 *
 * Chatterbox log shape: { level, name, time, key, context?, data?, error? }
 * where `key` is the short event name shown in its UI. Never put tokens or
 * API keys in `data`.
 */

const URL_BASE = (
	process.env.CHATTERBOX_API_URL ?? "https://chatterbox.otagera.xyz"
).replace(/\/$/, "");
const APP_NAME = process.env.CHATTERBOX_APP_NAME?.trim();
const SECRET = process.env.CHATTERBOX_API_SECRET?.trim();
const enabled = Boolean(APP_NAME && SECRET);

const FLUSH_MS = 5000;
const MAX_BATCH = 50;
const MAX_QUEUE = 1000;

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};
// The CLI prints its own messages, so the console default is quiet; the
// server image sets COUCH_LOG_LEVEL=info so `docker logs` shows activity.
const consoleLevel: Level = (
	["debug", "info", "warn", "error"].includes(process.env.COUCH_LOG_LEVEL ?? "")
		? process.env.COUCH_LOG_LEVEL
		: "warn"
) as Level;

interface ChatterboxLog {
	level: Level;
	name: string;
	time: number;
	key: string;
	context?: string;
	data?: Record<string, unknown>;
	error?: { type?: string; message?: string; stack?: string };
}

const queue: ChatterboxLog[] = [];
let timer: ReturnType<typeof setInterval> | undefined;
let sending: Promise<void> | undefined;

function errorFields(error: unknown): ChatterboxLog["error"] {
	if (error instanceof Error)
		return { type: error.name, message: error.message, stack: error.stack };
	return error === undefined ? undefined : { message: String(error) };
}

async function send(batch: ChatterboxLog[]): Promise<boolean> {
	try {
		const res = await fetch(`${URL_BASE}/api/logs/bulk`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				appName: APP_NAME as string,
				Authorization: `Bearer ${SECRET}`,
			},
			body: JSON.stringify({ logs: batch }),
			signal: AbortSignal.timeout(10_000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

/** Send everything queued. Failed batches go back on the queue once. */
export async function flushLogs(): Promise<void> {
	if (!enabled) return;
	if (sending) return sending;
	sending = (async () => {
		while (queue.length) {
			const batch = queue.splice(0, MAX_BATCH);
			if (!(await send(batch))) {
				// Keep them for the next interval, but never grow without bound.
				queue.unshift(...batch);
				queue.splice(MAX_QUEUE);
				break;
			}
		}
	})().finally(() => {
		sending = undefined;
	});
	return sending;
}

function enqueue(log: ChatterboxLog): void {
	if (!enabled) return;
	queue.push(log);
	if (queue.length > MAX_QUEUE) queue.shift();
	if (!timer) {
		timer = setInterval(() => void flushLogs(), FLUSH_MS);
		// Never keep a CLI process alive just to ship logs.
		timer.unref?.();
	}
}

export interface Logger {
	debug(key: string, data?: Record<string, unknown>): void;
	info(key: string, data?: Record<string, unknown>): void;
	warn(key: string, data?: Record<string, unknown>, error?: unknown): void;
	error(key: string, data?: Record<string, unknown>, error?: unknown): void;
}

/**
 * `context` names the module ("simkl", "picks"). `key` is an event name in
 * SCREAMING_SNAKE, matching the convention in Chatterbox (e.g. SYNC_DONE).
 */
export function createLogger(context: string): Logger {
	const write = (
		level: Level,
		key: string,
		data?: Record<string, unknown>,
		error?: unknown,
	) => {
		if (ORDER[level] >= ORDER[consoleLevel]) {
			const line = `[${context}] ${key}${data ? ` ${JSON.stringify(data)}` : ""}`;
			const out =
				level === "error"
					? console.error
					: level === "warn"
						? console.warn
						: console.log;
			out(
				line,
				...(error ? [error instanceof Error ? error.message : error] : []),
			);
		}
		enqueue({
			level,
			name: "couch",
			time: Date.now(),
			key,
			context,
			data,
			error: errorFields(error),
		});
	};
	return {
		debug: (key, data) => write("debug", key, data),
		info: (key, data) => write("info", key, data),
		warn: (key, data, error) => write("warn", key, data, error),
		error: (key, data, error) => write("error", key, data, error),
	};
}

export const chatterboxEnabled = enabled;
