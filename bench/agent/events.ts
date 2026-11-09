// Reads what `pi -p --mode json` printed for one run: one JSON event per LF
// (Pi's docs/json.md: split on LF only, a Unicode line separator inside a
// string is not a record boundary). Usage comes from each completed assistant
// message (message_end), tool calls from tool_execution_end.

export interface RunUsage {
	/** Input tokens not read from or written to the prompt cache. */
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	/** input + output + cacheRead + cacheWrite: every token the model processed. */
	readonly total: number;
}

export interface ParsedRun {
	readonly usage: RunUsage;
	/** Assistant messages: model round trips. */
	readonly turns: number;
	readonly toolCalls: Readonly<Record<string, number>>;
	readonly toolErrors: number;
	/** Text of the last assistant message. */
	readonly finalText: string;
	readonly stopReason: string | null;
	/** Context of the first model call (input + cache read + cache write): system prompt, tools and question. */
	readonly firstContext: number | null;
	/** True when Pi said it had no work left (agent_settled). */
	readonly settled: boolean;
	readonly errors: readonly string[];
}

interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

interface Message {
	role?: string;
	content?: unknown;
	usage?: Usage;
	stopReason?: string;
	errorMessage?: string;
}

interface Event {
	type?: string;
	message?: Message;
	toolName?: string;
	isError?: boolean;
	success?: boolean;
	finalError?: string;
}

export function parseEvents(jsonl: string): ParsedRun {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const toolCalls: Record<string, number> = {};
	const errors: string[] = [];
	let turns = 0;
	let toolErrors = 0;
	let finalText = "";
	let stopReason: string | null = null;
	let firstContext: number | null = null;
	let settled = false;
	for (const [index, raw] of jsonl.split("\n").entries()) {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (line.trim() === "") continue;
		let event: Event;
		try {
			event = JSON.parse(line) as Event;
		} catch {
			errors.push(`unparsable event line ${index + 1}`);
			continue;
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const message = event.message;
			const used = message.usage ?? {};
			usage.input += used.input ?? 0;
			usage.output += used.output ?? 0;
			usage.cacheRead += used.cacheRead ?? 0;
			usage.cacheWrite += used.cacheWrite ?? 0;
			firstContext ??= (used.input ?? 0) + (used.cacheRead ?? 0) + (used.cacheWrite ?? 0);
			turns += 1;
			finalText = textOf(message.content);
			stopReason = message.stopReason ?? null;
			if (message.stopReason === "error" || message.stopReason === "aborted") errors.push(message.errorMessage ?? `stopped: ${message.stopReason}`);
		} else if (event.type === "tool_execution_end") {
			const name = event.toolName ?? "?";
			toolCalls[name] = (toolCalls[name] ?? 0) + 1;
			if (event.isError === true) toolErrors += 1;
		} else if (event.type === "auto_retry_end" && event.success === false) {
			errors.push(event.finalError ?? "retries exhausted");
		} else if (event.type === "agent_settled") {
			settled = true;
		}
	}
	return {
		usage: { ...usage, total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite },
		turns,
		toolCalls,
		toolErrors,
		finalText,
		stopReason,
		firstContext,
		settled,
		errors,
	};
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => typeof part === "object" && part !== null && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}
