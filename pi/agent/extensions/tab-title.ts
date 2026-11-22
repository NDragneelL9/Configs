/**
 * Auto terminal tab title.
 *
 * The final title lands right after the first prompt, while the agent is
 * still working: a tiny parallel model call condenses the prompt into 1-2
 * words and is applied as soon as it returns (usually a few seconds in).
 *   - the moment the first prompt is submitted: "π <git branch or dir>"
 *   - a few seconds later, still during the run: the condensed 1-2 word
 *     label replaces the interim title (before the agent finishes)
 *   - the title is re-applied a few times to win races with pi's own title
 *     rewrites (startup package check on Windows, /name, session rebinds)
 *
 * The title is persisted as a custom session entry, so resuming the session
 * restores it. /name (manual session rename) wins over the auto title.
 *
 * Commands:
 *   /title <text>   set the title manually (disables auto-titling)
 *   /title off      keep the current title, disable auto-titling
 *   /title reset    re-enable auto-titling (next prompt retitles the tab)
 *   /title          show the current title
 *
 * Slash-command prompts (skill/template invocations like
 * "/grill-me <subject>") are titled by their subject: the leading command
 * tokens are stripped from the raw input, and the labeler is told to name
 * the thing being worked on, not the invoked skill or the activity.
 *
 * Titles are English-first: the labeler must translate the subject into
 * English, and English words are preferred everywhere. But if the labeler
 * still answers in the task's language (or the prompt has no English
 * words at all), that native label is kept — better a native title than a
 * fallback to the branch/dir interim title.
 *
 - Config: edit the constants below.
 */

import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ─── Config ────────────────────────────────────────────────────────────────
const INTERIM_PREFIX = "π "; // prefix of the interim title only; final titles have none
const MAX_LEN = 36; // max length of the label part
const MAX_WORDS = 3; // hard cap on words in the auto label
const USE_MODEL_LABEL = true; // ask the session model for the 1-2 word label
const INTERIM_FROM_BRANCH = true; // interim title (during first run) = git branch
const ALSO_SET_SESSION_NAME = false; // also rename the session (visible in /resume)
const LABEL_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 3_000;
// ────────────────────────────────────────────────────────────────────────────

const ENTRY_TYPE = "tab-title";

/** English (ASCII) words only — the auto title is always English. */
const ENGLISH_WORD = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const STOP_WORDS = new Set([
	"the", "a", "an", "please", "can", "you", "could", "would", "make", "fix-up",
	"мне", "нужно", "надо", "сделай", "сделать", "давай", "можно", "пожалуйста",
	"посмотри", "проверь", "хочу", "хотел", "бы", "ли",
]);

function sanitize(text: string): string {
	return text
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Drop slash-command tokens (/grill-me, /skill:foo) from raw input, so a
 * skill invocation "/grill-me redesign auth" labels as "redesign auth".
 * Applied only to input that starts with "/": a bare path argument like
 * "/etc/hosts" in the middle of a normal prompt is left alone.
 */
function stripCommands(text: string): string {
	return sanitize(text)
		.split(" ")
		.filter((w) => !(w.startsWith("/") && w.length > 1))
		.join(" ")
		.trim();
}

/**
 * First meaningful words of the prompt (fallback when no model call):
 * English words when the prompt has them, otherwise the prompt's own words.
 */
function heuristicLabel(prompt: string): string {
	const words = sanitize(prompt.replace(/[`*#>_|]+/g, " "))
		.split(" ")
		.filter((w) => w.length >= 2 && !STOP_WORDS.has(w.toLowerCase()));
	const english = words.filter((w) => ENGLISH_WORD.test(w));
	return (english.length > 0 ? english : words).slice(0, MAX_WORDS).join(" ");
}

/**
 * Enforce the label limits: drop stop/filler words, keep at most MAX_WORDS
 * words and MAX_LEN characters, cutting only on word boundaries. With
 * englishOnly (default) non-English (non-ASCII) words are dropped too;
 * englishOnly=false is the second pass for when the strict pass emptied
 * the label (the model insisted on the task's language).
 */
function constrainLabel(label: string, englishOnly = true): string {
	const words = sanitize(label)
		.split(" ")
		.filter((w) => (!englishOnly || ENGLISH_WORD.test(w)) && w.length >= 2 && !STOP_WORDS.has(w.toLowerCase()));
	let out = words.slice(0, MAX_WORDS).join(" ");
	if (out.length > MAX_LEN) {
		const s = out.slice(0, MAX_LEN);
		const cut = Math.max(s.lastIndexOf(" "), s.lastIndexOf("-"));
		out = cut >= 4 ? s.slice(0, cut) : s;
	}
	return sanitize(out);
}

/**
 * Pick an auto label from candidates. Each candidate is first constrained
 * to English words; if that empties it, the same candidate is kept in its
 * own words — better a native-language title than no title. First
 * non-empty result wins; empty string when every candidate is unusable.
 */
function pickLabel(...candidates: (string | undefined)[]): string {
	for (const candidate of candidates) {
		if (!candidate) continue;
		const label = constrainLabel(candidate) || constrainLabel(candidate, false);
		if (label) return label;
	}
	return "";
}

/** Last path segment of a branch name: feature/fix-auth -> fix-auth */
function shortBranch(branch: string): string {
	return branch.split("/").filter(Boolean).pop() ?? branch;
}

export default function (pi: ExtensionAPI) {
	let titled = false; // auto title already applied (or manual)
	let manual = false; // auto-titling disabled (user override)
	let firstInput: string | undefined; // raw first user input (pre-expansion)
	let pendingPrompt: string | undefined; // prompt waiting to be labeled
	let labelStarted = false; // label call already kicked off for this session
	let labelPromise: Promise<string | undefined> | undefined; // in-flight label call
	let lastAutoName: string | undefined; // session name we set ourselves

	function apply(ctx: ExtensionContext, title: string, persist = false): void {
		if (!ctx.hasUI || !title) return;
		ctx.ui.setTitle(title);
		if (persist) pi.appendEntry(ENTRY_TYPE, { title });
	}

	/**
	 * Apply and re-apply a few times: pi rewrites the title itself (startup
	 * package check on Windows, /name, session rebinds), so re-apply to win
	 * those races. Every re-apply is skipped once the user takes manual
	 * control (/name, /title), and is a cheap no-op otherwise.
	 */
	function applyArmored(ctx: ExtensionContext, title: string, persist = false): void {
		if (!ctx.hasUI || !title) return;
		if (persist) pi.appendEntry(ENTRY_TYPE, { title });
		const set = () => {
			if (!manual && ctx.hasUI) ctx.ui.setTitle(title);
		};
		set();
		for (const ms of [150, 1000, 3000]) setTimeout(set, ms);
	}

	/** pi also rewrites the title itself (startup, /name); apply slightly later to win. */
	function applySoon(ctx: ExtensionContext, title: string, persist = false, againMs?: number): void {
		if (!ctx.hasUI || !title) return;
		setTimeout(() => ctx.ui.setTitle(title), 60);
		if (persist) pi.appendEntry(ENTRY_TYPE, { title });
		if (againMs) setTimeout(() => ctx.ui.setTitle(title), againMs);
	}

	async function gitBranch(piApi: ExtensionAPI, cwd: string): Promise<string | undefined> {
		try {
			const r = await piApi.exec("git", ["branch", "--show-current"], { cwd, timeout: GIT_TIMEOUT_MS });
			const branch = (r.stdout ?? "").trim();
			return branch || undefined;
		} catch {
			return undefined;
		}
	}

	/** One tiny model call: condense the task into a 1-2 word tab label. */
	async function modelLabel(ctx: ExtensionContext, prompt: string): Promise<string | undefined> {
		const model = ctx.model;
		if (!model) return undefined;
		const options: Record<string, unknown> = { signal: AbortSignal.timeout(LABEL_TIMEOUT_MS) };
		if (model.reasoning) options.reasoning = "off";
		try {
			const message = await ctx.modelRegistry.complete(
				model,
				{
					systemPrompt:
						"You generate a short terminal tab title for a coding agent session. " +
						"Reply with ONLY the title: one to three words, at most 34 characters " +
						"total. Three words is a hard maximum — never four or more, never a " +
						"phrase or sentence. No quotes, no trailing punctuation, no " +
						"explanation. Always reply in English, whatever the task's " +
						"language: translate the subject into English. " +
						"Name the SUBJECT of the work - the feature, module, bug, document, " +
						"or plan the task is about - not the activity and not any invoked " +
						"skill or command. Examples: 'auth redesign', not 'grilling " +
						"interview'; 'parser bug', not 'code review'.",
					messages: [
					{
						role: "user",
						content: [{ type: "text", text: `Task: ${prompt.slice(0, 1500)}` }],
						timestamp: Date.now(),
					},
				],
				},
				options,
			);
			if (!message || message.stopReason === "error") return undefined;
			const text = (message.content ?? [])
				.filter((b): b is { type: "text"; text: string } => b.type === "text")
				.map((b) => b.text)
				.join(" ");
			return (
				sanitize(text)
					.replace(/^["'`\u201c\u201d]+|["'`\u201c\u201d.]+$/g, "")
					.trim() || undefined
			);
		} catch {
			return undefined;
		}
	}

	pi.on("session_start", (event, ctx) => {
		titled = false;
		manual = false;
		firstInput = undefined;
		pendingPrompt = undefined;
		labelStarted = false;
		labelPromise = undefined;
		if (!ctx.hasUI) return;

		// Restore the stored title, if this session was titled before.
		let stored: { title?: string } | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && (entry as { customType?: string }).customType === ENTRY_TYPE) {
				stored = (entry as { data?: { title?: string } }).data;
			}
		}
		if (stored?.title) {
			titled = true;
			manual = true; // keep it stable for the rest of the session
			// second shot: pi restores its own default title after the Windows
			// startup package check; re-apply to win that race too
			applySoon(ctx, stored.title, false, 2500);
			return;
		}
		// A named session (e.g. from /name earlier) is treated as manual.
		if (ctx.sessionManager.getSessionName()) manual = true;
	});

	pi.on("input", (event) => {
		if (firstInput || !event.text || event.source === "extension") return;
		if (event.text.startsWith("/")) {
			// Skill/template invocation ("/grill-me <subject>"): keep the raw
			// input, but drop the command tokens so the label names the subject,
			// not the invoked skill. Pure commands with nothing left are ignored.
			const rest = stripCommands(event.text);
			if (rest) firstInput = rest;
			return;
		}
		firstInput = event.text;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (titled || manual || labelStarted || !ctx.hasUI || event.messageType !== "user") return;
		const prompt = sanitize(firstInput ?? event.prompt ?? "");
		if (!prompt) return;
		pendingPrompt = prompt;
		labelStarted = true;

		// Interim title so the tab is useful immediately: folder name first
		// (instant), upgraded to the git branch when `git branch` answers.
		const interimCwd = constrainLabel(basename(ctx.cwd));
		if (interimCwd) ctx.ui.setTitle(INTERIM_PREFIX + interimCwd);
		if (INTERIM_FROM_BRANCH) {
			const branch = await gitBranch(pi, ctx.cwd);
			const interim = constrainLabel(branch ? shortBranch(branch) : basename(ctx.cwd));
			if (interim && !titled && !manual) ctx.ui.setTitle(INTERIM_PREFIX + interim);
		}

		// Kick off the label call in parallel with the agent run: the final
		// title is applied as soon as it returns, usually well before the
		// agent finishes answering.
		const sessionId = ctx.sessionManager.getSessionId();
		labelPromise = USE_MODEL_LABEL ? modelLabel(ctx, prompt) : Promise.resolve(undefined);
		void labelPromise.then((raw) => {
			if (titled || manual || !ctx.hasUI) return; // user overrode / fallback already ran
			if (ctx.sessionManager.getSessionId() !== sessionId) return; // session switched mid-run
			const label = pickLabel(raw);
			if (!label) return; // empty answer: let agent_settled use the heuristic
			titled = true;
			pendingPrompt = undefined;
			applyArmored(ctx, label, true);
		});
	});

	pi.on("agent_settled", async (event, ctx) => {
		const prompt = pendingPrompt;
		if (!prompt || titled || manual || !ctx.hasUI) return;
		// The label is normally already applied mid-run by the parallel call in
		// before_agent_start; this is only the fallback for when it never
		// returned (slow/failed model call). Abort no longer skips titling:
		// the title reflects the first prompt either way.
		titled = true;
		pendingPrompt = undefined;
		const sessionId = ctx.sessionManager.getSessionId();

		// Await the in-flight call instead of starting a duplicate.
		let label = await (labelPromise ?? modelLabel(ctx, prompt));
		label = pickLabel(label, heuristicLabel(prompt));
		if (!label) {
			const branch = await gitBranch(pi, ctx.cwd);
			label = constrainLabel(branch ? shortBranch(branch) : basename(ctx.cwd));
		}
		if (!label) return;
		// The session may have been switched/replaced while the label call ran.
		if (ctx.sessionManager.getSessionId() !== sessionId) return;

		applyArmored(ctx, label, true);

		if (ALSO_SET_SESSION_NAME) {
			lastAutoName = label.slice(0, 60);
			try {
				pi.setSessionName(lastAutoName);
			} catch {
				/* ignore */
			}
		}
	});

	pi.on("session_info_changed", (event, ctx) => {
		if (!ctx.hasUI || !event.name || event.name === lastAutoName) return;
		// The user named the session explicitly (/name): respect it, stop auto.
		manual = true;
		applySoon(ctx, sanitize(event.name).slice(0, MAX_LEN));
	});

	pi.registerCommand("title", {
		description: "Tab title: /title <text> | off | reset",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const arg = sanitize(args ?? "");
			if (!arg) {
				const name = ctx.sessionManager.getSessionName();
				ctx.ui.notify(name ? `Session name: ${name}` : "No explicit title set", "info");
				return;
			}
			if (arg.toLowerCase() === "off") {
				manual = true;
				titled = true;
				pi.appendEntry(ENTRY_TYPE, {}); // marker: no stored title
				ctx.ui.notify("Auto tab title disabled for this session", "info");
				return;
			}
			if (arg.toLowerCase() === "reset") {
				manual = false;
				titled = false;
				firstInput = undefined;
				pendingPrompt = undefined;
				labelStarted = false;
				labelPromise = undefined;
				pi.appendEntry(ENTRY_TYPE, {}); // marker: no stored title
				ctx.ui.notify("Tab title will be set from the next prompt", "info");
				return;
			}
			manual = true;
			titled = true;
			apply(ctx, arg.slice(0, MAX_LEN), true);
			ctx.ui.notify("Tab title set", "info");
		},
	});
}
