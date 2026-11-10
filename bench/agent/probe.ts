// A Pi extension loaded last in every real-agent run, adding no tool and no
// prompt text: before the agent starts it writes, to the file named by
// HEYDB_BENCH_PROBE, the tools declared to the model and the size of the
// system prompt, so the report can show every strategy started equal but for
// its tools.
import { writeFileSync } from "node:fs";

import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface Probe {
	readonly activeTools: readonly string[];
	readonly systemPromptChars: number;
	/** Name, description and parameter schema of each active tool. */
	readonly toolChars: number;
	/** Prompt sections set by extensions, by name, with their size. */
	readonly sections: Readonly<Record<string, number>>;
}

export default function probe(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
		const path = process.env.HEYDB_BENCH_PROBE;
		if (path === undefined || path === "") return undefined;
		const active = pi.getActiveTools();
		const tools = pi.getAllTools().filter((tool) => active.includes(tool.name));
		const sections: Record<string, number> = {};
		for (const [name, text] of Object.entries(event.systemPromptOptions.sections)) sections[name] = String(text ?? "").length;
		const result: Probe = {
			activeTools: [...active].sort(),
			systemPromptChars: event.systemPrompt.length,
			toolChars: tools.reduce((sum, tool) => sum + tool.name.length + tool.description.length + JSON.stringify(tool.parameters).length, 0),
			sections,
		};
		writeFileSync(path, JSON.stringify(result));
		return undefined;
	});
}
