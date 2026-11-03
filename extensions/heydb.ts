import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { aboutMessage } from "../lib/about.ts";

// Pi glue only: every behavior lives in lib/ so it stays testable and reusable outside Pi.
export default function heydb(pi: ExtensionAPI) {
	pi.registerCommand("heydb:about", {
		description: "Show the installed heydb version",
		handler: async (_args, ctx) => {
			ctx.ui.notify(aboutMessage(), "info");
		},
	});
}
