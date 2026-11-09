import type { ExtensionCommandContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, decodeKittyPrintable, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// A one-line input that never shows what is typed, for passwords. Pi's
// ctx.ui.input() echoes every character, and it has no hidden mode, so this
// is a small custom component shown through ctx.ui.custom().
//
// The key handling is a pure function, reduceSecret(state, key) → state, so
// tests drive it key by key without a terminal; the component around it only
// draws and forwards. The value lives in the component's state and is handed
// to the caller on Enter: it is never rendered, logged or put in an error.

export interface SecretState {
	readonly value: string;
	/** A bracketed paste still arriving in chunks; null when not pasting. */
	readonly paste: string | null;
	readonly outcome: "editing" | "submitted" | "cancelled";
}

export const EMPTY_SECRET: SecretState = { value: "", paste: null, outcome: "editing" };

/** What reduceSecret needs from Pi's key table. */
export type KeyMatcher = Pick<KeybindingsManager, "matches">;

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const segmenter = new Intl.Segmenter();

/** The next state after one chunk of terminal input. Never changes `state`. */
export function reduceSecret(state: SecretState, data: string, keys: KeyMatcher): SecretState {
	if (state.outcome !== "editing") return state;

	// A pasted password arrives between bracket markers, possibly split over
	// several chunks, and may end with a line break; like Pi's own input, the
	// breaks are dropped and the paste is taken whole.
	if (state.paste !== null || data.includes(PASTE_START)) {
		const buffer = state.paste ?? "";
		const incoming = state.paste === null ? data.slice(data.indexOf(PASTE_START) + PASTE_START.length) : data;
		const pasted = buffer + incoming;
		const end = pasted.indexOf(PASTE_END);
		if (end === -1) return { ...state, paste: pasted };
		const next = { ...state, value: state.value + pasted.slice(0, end).replace(/[\r\n]/g, ""), paste: null };
		const rest = pasted.slice(end + PASTE_END.length);
		return rest === "" ? next : reduceSecret(next, rest, keys);
	}

	if (keys.matches(data, "tui.select.cancel")) return { ...state, outcome: "cancelled" };
	if (keys.matches(data, "tui.input.submit") || data === "\n") return { ...state, outcome: "submitted" };
	if (keys.matches(data, "tui.editor.deleteCharBackward")) {
		const graphemes = [...segmenter.segment(state.value)];
		return { ...state, value: graphemes.slice(0, -1).map((item) => item.segment).join("") };
	}
	// Words cannot be seen, so deleting "a word" would delete an unknown part: these clear everything.
	if (keys.matches(data, "tui.editor.deleteToLineStart") || keys.matches(data, "tui.editor.deleteWordBackward")) {
		return { ...state, value: "" };
	}

	// Terminals with the Kitty keyboard protocol send even plain letters as escape sequences.
	const printable = decodeKittyPrintable(data) ?? (hasControlCharacters(data) ? undefined : data);
	return printable === undefined ? state : { ...state, value: state.value + printable };
}

function hasControlCharacters(data: string): boolean {
	return [...data].some((char) => {
		const code = char.charCodeAt(0);
		return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
	});
}

interface Theme {
	fg(color: "accent" | "dim", text: string): string;
}

/**
 * The component: a title, one "•" per character typed and a key hint. It
 * calls `done` with the value on Enter and with undefined on Escape.
 */
export function createSecretInput(
	title: string,
	tui: Pick<TUI, "requestRender">,
	theme: Theme,
	keys: KeyMatcher,
	done: (value: string | undefined) => void,
): Component {
	let state = EMPTY_SECRET;
	return {
		render(width: number): string[] {
			const dots = "•".repeat([...segmenter.segment(state.value)].length);
			// A long password shows its last dots, where the next one appears.
			const visible = dots.length + 2 > width ? dots.slice(dots.length - Math.max(0, width - 3)) : dots;
			return [
				// The title says where the password goes, so it wraps instead of being cut.
				...wrapTextWithAnsi(theme.fg("accent", title), width),
				truncateToWidth(`> ${visible}`, width),
				truncateToWidth(theme.fg("dim", "enter saves · esc cancels"), width),
			];
		},
		handleInput(data: string): void {
			state = reduceSecret(state, data, keys);
			if (state.outcome === "submitted") return done(state.value);
			if (state.outcome === "cancelled") return done(undefined);
			tui.requestRender();
		},
		invalidate(): void {},
	};
}

/**
 * Asks for a secret with the masked input. Returns the value, undefined when
 * the person pressed Escape, or null when Pi has no terminal UI to show it
 * (RPC, print and JSON modes): the caller then explains how to set it instead.
 */
export async function askSecret(ctx: ExtensionCommandContext, title: string): Promise<string | undefined | null> {
	if (ctx.mode !== "tui") return null;
	return ctx.ui.custom<string | undefined>(
		(tui, theme, keybindings, done) => createSecretInput(title, tui, theme, keybindings, done),
		// Terminals that show program status then mark Pi as waiting for an answer.
		{ blocked: { kind: "question", message: title } },
	);
}
