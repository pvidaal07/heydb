import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";

import { EMPTY_SECRET, type SecretState, askSecret, createSecretInput, reduceSecret } from "../../extensions/secret-input.ts";

// The real key table Pi uses, so "\x7f" is backspace here exactly as in a terminal.
const keys = new KeybindingsManager(TUI_KEYBINDINGS);

function type(...chunks: string[]): SecretState {
	return chunks.reduce((state, data) => reduceSecret(state, data, keys), EMPTY_SECRET);
}

describe("reduceSecret", () => {
	test("appends what is typed, Unicode included", () => {
		assert.deepEqual(type("p", "4", "ñ", "密", "🔑", " ", "#"), { value: "p4ñ密🔑 #", paste: null, outcome: "editing" });
	});

	test("backspace removes the last character as a person sees it, and does nothing when empty", () => {
		assert.equal(type("a", "👍🏽", "\x7f").value, "a");
		assert.equal(type("é", "\x7f", "\x7f").value, "");
	});

	test("ctrl+u and ctrl+w clear the whole value: words are invisible here", () => {
		assert.equal(type("abc", "\x15").value, "");
		assert.equal(type("abc def", "\x17").value, "");
	});

	test("decodes printable keys sent with the Kitty keyboard protocol", () => {
		assert.equal(type("\x1b[97u", "\x1b[97:65;2u").value, "aA");
	});

	test("ignores arrows, tab and other control keys", () => {
		assert.equal(type("a", "\x1b[D", "\t", "\x01", "\x1b[A", "b").value, "ab");
	});

	test("takes a bracketed paste whole, without its line breaks, even across chunks", () => {
		assert.equal(type("x", "\x1b[200~p@ss word\r\n\x1b[201~").value, "xp@ss word");
		assert.deepEqual(type("\x1b[200~ab", "c\x1b[2", "01~d"), { value: "abcd", paste: null, outcome: "editing" });
		assert.equal(type("\x1b[200~a\x1b[201~\r").outcome, "submitted", "keys after the paste still count");
	});

	test("enter submits and escape or ctrl+c cancel; nothing changes afterwards", () => {
		assert.deepEqual(type("s3", "\r", "x", "\x7f"), { value: "s3", paste: null, outcome: "submitted" });
		assert.equal(type("s3", "\x1b").outcome, "cancelled");
		assert.equal(type("s3", "\x03").outcome, "cancelled");
		assert.equal(type("\r").value, "", "an empty answer is a valid submission");
	});

	test("never changes the state it is given", () => {
		const state = Object.freeze({ value: "ab", paste: null, outcome: "editing" as const });
		reduceSecret(state, "c", keys);
		assert.equal(state.value, "ab");
	});
});

/** Builds the component like Pi does and records renders and the final answer. */
function mount(title: string) {
	const answers: (string | undefined)[] = [];
	let renders = 0;
	const tui = { requestRender: () => (renders += 1) };
	const theme = { fg: (_color: string, text: string) => text };
	const component = createSecretInput(title, tui as never, theme as never, keys, (value) => answers.push(value));
	return { component, answers, renders: () => renders };
}

describe("createSecretInput", () => {
	test("shows one dot per character, never the value, and answers it on enter", () => {
		const { component, answers, renders } = mount("Password for local");
		for (const char of "s3cr3t") component.handleInput?.(char);
		const lines = component.render(60);
		assert.equal(lines[0], "Password for local");
		assert.equal(lines[1], "> ••••••");
		assert.doesNotMatch(lines.join("\n"), /s3cr3t/);
		assert.equal(renders(), 6);
		component.handleInput?.("\r");
		assert.deepEqual(answers, ["s3cr3t"]);
	});

	test("escape answers undefined", () => {
		const { component, answers } = mount("Password");
		component.handleInput?.("a");
		component.handleInput?.("\x1b");
		assert.deepEqual(answers, [undefined]);
	});

	test("every line fits the width, however long the value", () => {
		const { component } = mount("A very long title that does not fit in a narrow terminal");
		for (let i = 0; i < 100; i += 1) component.handleInput?.("x");
		for (const line of component.render(20)) assert.ok(visibleWidth(line) <= 20, line);
	});
});

describe("askSecret", () => {
	test("outside Pi's terminal UI, returns null without showing anything", async () => {
		let shown = false;
		for (const mode of ["rpc", "print", "json"]) {
			const ctx = { mode, hasUI: mode === "rpc", ui: { custom: async () => (shown = true) } };
			assert.equal(await askSecret(ctx as unknown as ExtensionCommandContext, "Password"), null);
		}
		assert.equal(shown, false);
	});

	test("in the terminal UI, shows the masked input and reports Pi as waiting for an answer", async () => {
		let options: unknown;
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				custom: async (factory: (...args: unknown[]) => { handleInput(data: string): void }, given: unknown) => {
					options = given;
					let answer: unknown;
					const component = factory({ requestRender() {} }, { fg: (_: string, text: string) => text }, keys, (value: unknown) => {
						answer = value;
					});
					for (const data of ["o", "k", "\r"]) component.handleInput(data);
					return answer;
				},
			},
		};
		assert.equal(await askSecret(ctx as unknown as ExtensionCommandContext, "Password"), "ok");
		assert.deepEqual(options, { blocked: { kind: "question", message: "Password" } });
	});
});
