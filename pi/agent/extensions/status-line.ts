/**
 * Minimal footer stats line.
 *
 * First line: cwd + oh-my-posh-like git state + session name, e.g.
 *   ~/work/repo (main ↑2 ●1 +3 ?2) • fix-auth   branch, ahead 2; staged 1, modified 3, untracked 2
 *   ~/work/repo (main ↓1) • fix-auth            behind 1 (run pull)
 *   ~/work/repo (main ✓) • fix-auth             clean and synced with remote
 *   ~/work/repo (main) • fix-auth               clean, no upstream
 * Git state comes from `git status --porcelain=v1 --branch` (cached, refreshed
 * after agent activity/tool calls and a once-a-minute tick).
 *
 * Stats line: extension statuses (zai-usage quota), then cumulative session
 * cost, context tokens in the session, and wall-clock time since the first
 * prompt (instead of `%/1.0M`), model (+ thinking level, provider) right-aligned.
 *
 * Toggle back to the built-in footer with /footer-default.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Same token formatting as the built-in footer. */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Same cwd abbreviation as the built-in footer (~ for home). */
function formatCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const rc = resolve(cwd);
	const rh = resolve(home);
	const rel = relative(rh, rc);
	const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!inside) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

interface GitInfo {
	branch: string;
	detached: boolean;
	hasUpstream: boolean;
	ahead: number;
	behind: number;
	staged: number;
	unstaged: number;
	untracked: number;
	conflicts: number;
}

/** Parse `git status --porcelain=v1 --branch` output; null when the repo state is unreadable. */
function parseGitStatus(out: string): GitInfo | null {
	const lines = out.split(/\r?\n/);
	const header = lines[0] ?? "";
	if (!header.startsWith("## ")) return null;
	const info: GitInfo = {
		branch: "",
		detached: false,
		hasUpstream: false,
		ahead: 0,
		behind: 0,
		staged: 0,
		unstaged: 0,
		untracked: 0,
		conflicts: 0,
	};
	const head = header.slice(3);
	if (head === "HEAD (no branch)") {
		info.detached = true;
		info.branch = "detached";
	} else if (head.startsWith("No commits yet on ")) {
		info.branch = head.slice("No commits yet on ".length);
	} else {
		const dotdot = head.indexOf("...");
		info.branch = dotdot === -1 ? head : head.slice(0, dotdot);
		if (dotdot !== -1) {
			info.hasUpstream = true;
			const bracket = head.match(/\[(.+)\]$/);
			if (bracket) {
				info.ahead = Number(bracket[1].match(/ahead (\d+)/)?.[1] ?? 0);
				info.behind = Number(bracket[1].match(/behind (\d+)/)?.[1] ?? 0);
			}
		}
	}
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line) continue;
		const x = line[0];
		const y = line[1];
		if (x === "?" && y === "?") {
			info.untracked++;
			continue;
		}
		if (x === "!" && y === "!") continue;
		if (x === "U" || y === "U" || (x === "D" && y === "D") || (x === "A" && y === "A")) {
			info.conflicts++;
			continue;
		}
		if (x !== " ") info.staged++;
		if (y !== " ") info.unstaged++;
	}
	return info;
}

/** oh-my-posh-like git segment: `(main ↑2 ●1 +3 ?2)`, `(main ✓)`, or `(main)` when no upstream. */
function formatGitSegment(theme: Theme, info: GitInfo): string {
	const parts: string[] = [];
	parts.push(theme.fg(info.detached ? "warning" : "accent", info.branch));
	if (info.ahead > 0) parts.push(theme.fg("warning", `↑${info.ahead}`));
	if (info.behind > 0) parts.push(theme.fg("warning", `↓${info.behind}`));
	if (info.conflicts > 0) parts.push(theme.fg("error", `✗${info.conflicts}`));
	if (info.staged > 0) parts.push(theme.fg("accent", `●${info.staged}`));
	if (info.unstaged > 0) parts.push(theme.fg("warning", `+${info.unstaged}`));
	if (info.untracked > 0) parts.push(theme.fg("muted", `?${info.untracked}`));
	if (parts.length === 1 && info.hasUpstream) parts.push(theme.fg("success", "✓"));
	return `(${parts.join(" ")})`;
}

/** Last fetched git state; null when not a repo or before the first fetch settles. */
let gitInfo: GitInfo | null = null;
let gitFetch: Promise<void> | null = null;
let gitForcePending = false;
let lastGitRun = 0;
const GIT_MIN_INTERVAL_MS = 5_000;

/**
 * Fetch git state in the background; render stays sync and reads `gitInfo`.
 * At most one git process is in flight: calls during a fetch are dropped, except
 * forced ones (agent settled), which are remembered and re-run after it completes
 * so the final state after agent work is never missed.
 */
function refreshGit(
	pi: ExtensionAPI,
	cwd: string,
	force: boolean,
	requestRender: () => void,
): void {
	if (gitFetch) {
		if (force) gitForcePending = true;
		return;
	}
	if (!force && Date.now() - lastGitRun < GIT_MIN_INTERVAL_MS) return;
	lastGitRun = Date.now();
	gitFetch = (async () => {
		try {
			const r = await pi.exec("git", ["status", "--porcelain=v1", "--branch", "--no-renames"], {
				cwd,
				timeout: 5_000,
			});
			if (r.code === 0) gitInfo = parseGitStatus(r.stdout);
			else if (/not a git repository/i.test(r.stderr)) gitInfo = null;
		} catch {
			// keep last known state on transient failures
		} finally {
			gitFetch = null;
		}
		requestRender();
		if (gitForcePending) {
			gitForcePending = false;
			refreshGit(pi, cwd, true, requestRender);
		}
	})();
}

interface Stats {
	cost: number;
	ctxTokens: number | null;
	ctxPercent: number | null;
	firstPromptAt: number | null;
}

/** Compact wall-clock duration, e.g. "42m", "2h07m", "3d4h". */
function fmtElapsed(ms: number): string {
	if (ms < 60_000) return "<1m";
	const totalMin = Math.floor(ms / 60_000);
	if (totalMin < 60) return `${totalMin}m`;
	const h = Math.floor(totalMin / 60);
	if (h < 24) return `${h}h${String(totalMin % 60).padStart(2, "0")}m`;
	const d = Math.floor(h / 24);
	return `${d}d${h % 24}h`;
}

/** Cumulative usage from all session entries + context tokens (same loop as the built-in footer). */
function computeStats(ctx: ExtensionContext): Stats {
	let cost = 0;
	let firstPromptAt: number | null = null;
	for (const entry of ctx.sessionManager.getEntries()) {
		const e = entry as any;
		if (e.type === "usage") {
			cost += e.usage?.cost?.total ?? 0;
		} else if (e.type === "message" && e.message?.role === "assistant") {
			cost += e.message.usage?.cost?.total ?? 0;
		} else if (e.type === "message" && e.message?.role === "toolResult" && e.message.usage) {
			cost += e.message.usage.cost?.total ?? 0;
		} else if ((e.type === "branch_summary" || e.type === "compaction") && e.usage) {
			cost += e.usage.cost?.total ?? 0;
		} else if (
			firstPromptAt === null &&
			e.type === "message" &&
			e.message?.role === "user" &&
			typeof e.timestamp === "string" &&
			Number.isFinite(Date.parse(e.timestamp))
		) {
			firstPromptAt = Date.parse(e.timestamp);
		}
	}
	const ctxUsage = ctx.getContextUsage();
	return {
		cost,
		firstPromptAt,
		ctxTokens: ctxUsage?.tokens ?? null,
		ctxPercent: ctxUsage?.percent ?? null,
	};
}

function renderFooter(
	ctx: ExtensionContext,
	theme: Theme,
	footerData: {
		getGitBranch(): string | null;
		getExtensionStatuses(): ReadonlyMap<string, string>;
		getAvailableProviderCount(): number;
	},
	width: number,
): string[] {
	// Memoize stats the same way the built-in footer does: entries are append-only and
	// every append moves the leaf, so sessionId|leafId|model changes whenever stats do.
	const sessionManager: any = ctx.sessionManager;
	const key = `${sessionManager.getSessionId()}|${sessionManager.getLeafId()}|${ctx.model?.id ?? ""}`;
	const cache = (renderFooter as any)._cache as { key: string; stats: Stats } | undefined;
	let stats: Stats;
	if (cache && cache.key === key) {
		stats = cache.stats;
	} else {
		stats = computeStats(ctx);
		(renderFooter as any)._cache = { key, stats };
	}

	// pwd line: cwd (git segment) • session name
	let pwd = theme.fg("dim", formatCwd(sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE));
	if (gitInfo) {
		pwd += ` ${formatGitSegment(theme, gitInfo)}`;
	} else {
		const branch = footerData.getGitBranch();
		if (branch) pwd += ` ${theme.fg("dim", `(${branch})`)}`;
	}
	const sessionName = sessionManager.getSessionName();
	if (sessionName) pwd += theme.fg("dim", ` • ${sessionName}`);

	// Stats line: extension statuses (zai first), then cost, context tokens and
	// session wall-clock time since the first prompt
	const parts: string[] = [];
	const statuses = footerData.getExtensionStatuses();
	if (statuses.size > 0) {
		parts.push(
			Array.from(statuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, t]) => sanitizeStatusText(t))
				.join(" "),
		);
		// Visual break between the zai quota block and the session stats.
		parts.push(theme.fg("dim", "·"));
	}
	parts.push(theme.fg("dim", `$${stats.cost.toFixed(3)}`));

	const ctxStr = stats.ctxTokens === null ? "?" : formatTokens(stats.ctxTokens);
	const ctxDisplay =
		stats.ctxPercent !== null && stats.ctxPercent > 90
			? theme.fg("error", ctxStr)
			: stats.ctxPercent !== null && stats.ctxPercent > 70
				? theme.fg("warning", ctxStr)
				: ctxStr;
	parts.push(ctxDisplay);

	if (stats.firstPromptAt !== null) {
		parts.push(theme.fg("dim", fmtElapsed(Date.now() - stats.firstPromptAt)));
	}

	let statsLeft = parts.join(" ");

	// Right side: model name + thinking level, provider prefix when several are available
	const modelName = ctx.model?.id || "no-model";
	let rightSide = modelName;
	if (ctx.model?.reasoning) {
		const level = ctx.thinkingLevel || "off";
		rightSide = level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
	}
	if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
		const withProvider = `(${ctx.model.provider}) ${rightSide}`;
		if (visibleWidth(statsLeft) + 2 + visibleWidth(withProvider) <= width) rightSide = withProvider;
	}

	const leftWidth = visibleWidth(statsLeft);
	const rightWidth = visibleWidth(rightSide);
	let statsLine: string;
	if (leftWidth + 2 + rightWidth <= width) {
		statsLine = statsLeft + " ".repeat(width - leftWidth - rightWidth) + rightSide;
	} else {
		statsLeft = truncateToWidth(statsLeft, width, "...");
		statsLine = statsLeft;
	}

	const lines = [truncateToWidth(pwd, width, theme.fg("dim", "...")), statsLine];
	return lines;
}

export default function (pi: ExtensionAPI) {
	let activeTui: { requestRender(): void } | undefined;
	let activeSession: { getCwd(): string } | undefined;
	let renderTick: ReturnType<typeof setInterval> | undefined;

	const requestRender = () => activeTui?.requestRender();

	function scheduleGitRefresh(force = false) {
		if (activeSession) refreshGit(pi, activeSession.getCwd(), force, requestRender);
	}

	function clearRenderTick() {
		if (renderTick) {
			clearInterval(renderTick);
			renderTick = undefined;
		}
	}

	function install(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") return;
		activeSession = ctx.sessionManager;
		ctx.ui.setFooter((tui, theme, footerData) => {
			activeTui = tui;
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			// Tick once a minute: advance the session elapsed time and refresh git state
			// (covers commits made outside pi, e.g. in another terminal or via `!`).
			clearRenderTick();
			renderTick = setInterval(() => {
				requestRender();
				scheduleGitRefresh();
			}, 60_000);
			return {
				dispose: () => {
					unsub();
					clearRenderTick();
				},
				invalidate() {},
				render: (width: number) => renderFooter(ctx, theme, footerData, width),
			};
		});
		scheduleGitRefresh(true);
	}

	pi.on("session_start", (_event, ctx) => install(ctx));

	// Stats change when a response settles; git state too (agent may have written/committed).
	pi.on("agent_settled", () => {
		requestRender();
		scheduleGitRefresh(true);
	});

	// Tool calls (edits, bash) mutate the work tree; refresh throttled to GIT_MIN_INTERVAL_MS.
	pi.on("tool_execution_end", () => scheduleGitRefresh());

	pi.on("session_shutdown", () => {
		activeTui = undefined;
		clearRenderTick();
	});

	pi.registerCommand("footer-default", {
		description: "Restore the built-in footer (undo status-line extension)",
		handler: async (_args, ctx) => {
			activeTui = undefined;
			clearRenderTick();
			if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
			ctx.ui.notify("Built-in footer restored (remove/rename extensions/status-line.ts to make it permanent)", "info");
		},
	});
}
