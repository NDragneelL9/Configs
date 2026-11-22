/**
 * Clean startup header.
 *
 * Replaces the built-in startup header (logo, version, key hints) with an
 * identical copy minus the "Pi can explain its own features..." onboarding
 * line. Ctrl+T still expands the full keybinding help; colors snapshot at
 * session start (a /theme switch mid-session refreshes on the next
 * session_start, e.g. after /reload or a new session).
 *
 * Pairs with `"quietStartup": "header"` in settings.json, which hides the
 * model-scope line and the loaded-resources listing ([Skills], [Extensions],
 * ...) - those are covered by the setting, not by this extension.
 *
 * /header-default restores the built-in header until the next session start.
 */

import {
	VERSION,
	keyHint,
	keyText,
	rawKeyHint,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Text,
	backgroundAnsi,
	foregroundAnsi,
	isAppleTerminalSession,
	rgbColor,
} from "@earendil-works/pi-tui";

// Brand colors of the pi logo; fixed across themes, they follow the terminal's color mode.
const CORAL = rgbColor(228, 138, 122);
const BLUE = rgbColor(79, 142, 179);
const YELLOW = rgbColor(234, 182, 93);
const RESET = "\x1b[0m";

function logoLines(theme: Theme): [string, string] {
	const mode = theme.getColorMode();
	const top = `${foregroundAnsi(CORAL, mode)}${backgroundAnsi(BLUE, mode)}▀${RESET}${foregroundAnsi(CORAL, mode)}▀█${RESET} `;
	const bottom = `${foregroundAnsi(BLUE, mode)}█▀${RESET} ${foregroundAnsi(YELLOW, mode)}█${RESET}`;
	return [top, bottom];
}

function wordmark(theme: Theme): string {
	const mode = theme.getColorMode();
	return `${foregroundAnsi(CORAL, mode)}P${RESET}${foregroundAnsi(YELLOW, mode)}i${RESET}`;
}

/** Mirrors the built-in header component (paddingX 1, expandable via Ctrl+T). */
class CleanHeader extends Text {
	private expanded = false;
	private stale = true;

	constructor(
		private theme: Theme,
		private buildCollapsedText: () => string,
		private buildExpandedText: () => string,
	) {
		super("", 1, 0);
	}

	setExpanded(expanded: boolean) {
		this.expanded = expanded;
		this.invalidate();
	}

	invalidate(): void {
		super.invalidate();
		this.stale = true;
	}

	render(width: number): readonly string[] {
		if (this.stale) {
			this.stale = false;
			this.setText(this.expanded ? this.buildExpandedText() : this.buildCollapsedText());
		}
		return super.render(width);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		// The built-in header appends " and loaded resources" only when the listing is visible.
		const quiet = pi.getSettings().quietStartup !== false;
		const resourcesSuffix = quiet ? "" : " and loaded resources";

		ctx.ui.setHeader((_tui, theme) => {
			const withLogo = (hints: string) => {
				if (isAppleTerminalSession()) {
					return `${wordmark(theme)} ${theme.fg("dim", `v${VERSION}`)}\n${hints}`;
				}
				const [top, bottom] = logoLines(theme);
				return `${top} ${theme.fg("dim", `v${VERSION}`)}\n${bottom} ${hints}`;
			};

			const compactHints = [
				keyHint("app.interrupt", "interrupt"),
				rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
				rawKeyHint("/", "commands"),
				rawKeyHint("!", "bash"),
				keyHint("app.tools.expand", "more"),
			].join(theme.fg("muted", " · "));

			const compactOnboarding = theme.fg(
				"dim",
				`Press ${keyText("app.tools.expand")} to show full startup help${resourcesSuffix}.`,
			);

			const expandedHints = [
				keyHint("app.interrupt", "to interrupt"),
				keyHint("app.clear", "to clear"),
				rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
				keyHint("app.exit", "to exit (empty)"),
				keyHint("app.suspend", "to suspend"),
				keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
				keyHint("app.thinking.cycle", "to cycle thinking level"),
				rawKeyHint(
					`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`,
					"to cycle models",
				),
				keyHint("app.model.select", "to select model"),
				keyHint("app.tools.expand", "to expand tools"),
				keyHint("app.thinking.toggle", "to expand thinking"),
				keyHint("app.editor.external", "for external editor"),
				rawKeyHint("/", "for commands"),
				rawKeyHint("!", "to run bash"),
				rawKeyHint("!!", "to run bash (no context)"),
				keyHint("app.message.followUp", "to queue follow-up"),
				keyHint("app.message.dequeue", "to edit all queued messages"),
				keyHint("app.clipboard.pasteImage", "to paste files on macOS, images, or text"),
				rawKeyHint("drop files", "to attach"),
			].join("\n");

			return new CleanHeader(
				theme,
				() => `${withLogo(compactHints)}\n${compactOnboarding}`,
				() => withLogo(expandedHints),
			);
		});
	});

	pi.registerCommand("header-default", {
		description: "Restore the built-in startup header (until next session start)",
		handler: async (_args, ctx) => {
			ctx.ui.setHeader(undefined);
		},
	});
}
