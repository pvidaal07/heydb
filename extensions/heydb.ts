import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerHeydbCommands } from "./commands.ts";
import { createContextHandler } from "./context.ts";
import { type HeydbDeps, defaultDeps } from "./deps.ts";
import { registerHeydbTools } from "./tools.ts";

// Pi glue only: every behavior lives in lib/ so it stays testable and reusable
// outside Pi. This file wires the pieces; each piece takes its dependencies
// as an argument, so tests run them with fakes.

export default function heydb(pi: ExtensionAPI): void {
	registerHeydb(pi, defaultDeps());
}

export function registerHeydb(pi: ExtensionAPI, deps: HeydbDeps): void {
	registerHeydbCommands(pi, deps);
	registerHeydbTools(pi, deps);
	pi.on("before_agent_start", createContextHandler());
}
