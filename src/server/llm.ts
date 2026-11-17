/**
 * OpenRouter chat completions, used for the two LLM steps: summarising the
 * user's history into a taste profile, and choosing picks from candidates.
 */

import { requireConfig } from "./config.ts";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface ChatResult {
	text: string;
	model: string;
	costUsd: number | null;
}

export async function chat(
	model: string,
	messages: ChatMessage[],
	options: { json?: boolean; maxTokens?: number } = {},
): Promise<ChatResult> {
	const key = requireConfig(
		"openRouterApiKey",
		"OPENROUTER_API_KEY",
		"Create one at https://openrouter.ai/keys.",
	);
	const res = await fetch(ENDPOINT, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
			"X-Title": "Couch",
		},
		body: JSON.stringify({
			model,
			messages,
			max_tokens: options.maxTokens ?? 4000,
			...(options.json ? { response_format: { type: "json_object" } } : {}),
			usage: { include: true },
		}),
		signal: AbortSignal.timeout(180_000),
	});
	const body = (await res.json().catch(() => ({}))) as {
		model?: string;
		choices?: { message?: { content?: string } }[];
		usage?: { cost?: number };
		error?: { message?: string };
	};
	if (!res.ok) {
		throw new Error(
			`OpenRouter ${res.status}: ${body.error?.message ?? "request failed"}`,
		);
	}
	const text = body.choices?.[0]?.message?.content ?? "";
	if (!text) throw new Error("OpenRouter returned an empty response.");
	return {
		text,
		model: body.model ?? model,
		costUsd: body.usage?.cost ?? null,
	};
}

/** Parse a JSON object from model output, tolerating a ```json fence. */
export function parseJson<T>(text: string): T {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const raw = (fenced ? fenced[1] : text).trim();
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end < start)
		throw new Error("Model response contained no JSON object.");
	return JSON.parse(raw.slice(start, end + 1)) as T;
}
