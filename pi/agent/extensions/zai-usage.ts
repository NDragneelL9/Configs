/**
 * Z.ai GLM Coding Plan usage tracker.
 *
 * Shows the subscription quota (5-hour window + monthly credits) in the pi
 * footer and adds the /zai-usage command with a detailed card (limits, reset
 * times, 7-day request/token stats).
 *
 * Uses the official Z.ai monitor API (the same endpoints as the official
 * glm-plan-usage plugin and community trackers):
 *   GET {base}/api/monitor/usage/quota/limit
 *   GET {base}/api/monitor/usage/model-usage?startTime=...&endTime=...
 *
 * The API key is resolved from the configured pi "zai" provider via
 * ctx.modelRegistry.getProviderAuth(), so /login is the single source of truth.
 *
 - Config: edit the constants below (provider id, refresh interval, thresholds).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const PROVIDER_ID = "zai";
const DEFAULT_BASE = "https://api.z.ai";
const REFRESH_MS = 5 * 60 * 1000; // footer refresh interval
const SETTLED_REFRESH_MS = 60 * 1000; // min spacing of refreshes after agent runs
const RENDER_TICK_MS = 60 * 1000; // local footer re-render tick (no API call)
const FETCH_TIMEOUT_MS = 15_000;
const STATUS_KEY = "zai-usage";

interface ZaiLimit {
	type: string;
	unit?: number;
	number?: number;
	usage?: number; // total quota
	currentValue?: number; // used
	remaining?: number;
	percentage?: number;
	nextResetTime?: number; // epoch ms
}

interface WindowInfo {
	label: string;
	used?: number;
	total?: number;
	remaining?: number;
	percentage?: number;
	resetAt?: number;
}

interface UsageData {
	level?: string;
	windows: WindowInfo[];
	fetchedAt: number;
}

interface UsageEntryData extends UsageData {
	sevenDay?: { prompts?: number; tokens?: number };
	error?: string;
}

// Observed in the live API: unit 3 = hour (number 5 -> 5-hour window),
// unit 6 = month (number 1 -> monthly credits). Legacy types kept for older
// API revisions (TOKENS_LIMIT = 5h tokens, TIME_LIMIT = monthly MCP).
const UNIT_MS: Record<number, number> = {
	3: 60 * 60 * 1000,
	4: 24 * 60 * 60 * 1000,
	6: 30 * 24 * 60 * 60 * 1000,
};

function durationOf(l: ZaiLimit): number {
	if (l.type === "TOKENS_LIMIT") return 5 * UNIT_MS[3]!;
	if (l.type === "TIME_LIMIT") return UNIT_MS[6]!;
	const unitMs = UNIT_MS[l.unit ?? -1];
	if (unitMs && typeof l.number === "number" && l.number > 0) return unitMs * l.number;
	return Number.MAX_SAFE_INTEGER; // unknown window -> sort last
}

function labelOf(l: ZaiLimit): string {
	if (l.type === "TOKENS_LIMIT") return "5h tokens";
	if (l.type === "TIME_LIMIT") return "monthly MCP";
	if (l.unit === 3 && l.number) return `${l.number}h credits`;
	if (l.unit === 6 && l.number) return l.number === 1 ? "monthly credits" : `${l.number}mo credits`;
	return l.type.replace(/_/g, " ").toLowerCase();
}

function windowsFromLimits(limits: unknown): WindowInfo[] {
	if (!Array.isArray(limits)) return [];
	return (limits as ZaiLimit[])
		.filter((l) => l && typeof l === "object")
		.map((l) => ({ limit: l, ms: durationOf(l) }))
		.sort((a, b) => a.ms - b.ms)
		.map(({ limit }) => ({
			label: labelOf(limit),
			used: limit.currentValue,
			total: limit.usage,
			remaining: limit.remaining,
			percentage: limit.percentage,
			resetAt: typeof limit.nextResetTime === "number" ? limit.nextResetTime : undefined,
		}));
}

function fmtInt(n?: number): string {
	return typeof n === "number" ? n.toLocaleString("en-US") : "?";
}

function fmtTokens(n?: number): string {
	if (typeof n !== "number") return "?";
	if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
	return String(n);
}

function colorFor(pct?: number): "success" | "warning" | "error" | "muted" {
	if (typeof pct !== "number") return "muted";
	if (pct >= 95) return "error";
	if (pct >= 70) return "warning";
	return "success";
}

function bar(theme: ExtensionContext["ui"]["theme"], pct?: number, width = 10): string {
	const filled = Math.max(0, Math.min(width, Math.round(((pct ?? 0) / 100) * width)));
	return theme.fg(colorFor(pct), "█".repeat(filled)) + theme.fg("dim", "░".repeat(width - filled));
}

function fmtDuration(ms: number): string {
	if (ms <= 0) return "now";
	const m = Math.floor(ms / 60_000);
	if (m < 1) return "<1m";
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h ${m % 60}m`;
	return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function fmtReset(resetAt?: number): string {
	if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) return "";
	const ms = resetAt - Date.now();
	if (ms <= 0) return "resetting…";
	const d = new Date(resetAt);
	const at =
		ms < 48 * 3_600_000
			? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
			: d.toLocaleString("en-GB", {
					day: "numeric",
					month: "short",
					hour: "2-digit",
					minute: "2-digit",
				});
	return `resets in ${fmtDuration(ms)} (${at})`;
}

// Footer tag: time remaining until the window resets (e.g. "2h31m", "3d12h").
function resetTag(theme: ExtensionContext["ui"]["theme"], w: WindowInfo): string {
	if (typeof w.resetAt !== "number" || !Number.isFinite(w.resetAt)) return "";
	const ms = w.resetAt - Date.now();
	if (ms <= 0) return theme.fg("dim", " now");
	return theme.fg("dim", ` ${fmtDuration(ms).replaceAll(" ", "")}`);
}

async function apiGet(url: string, token: string): Promise<any> {
	// The official plugin sends the raw token; some setups use Bearer. Try both.
	for (const auth of [token, `Bearer ${token}`]) {
		const res = await fetch(url, {
			headers: {
				Authorization: auth,
				"Accept-Language": "en-US,en",
				"Content-Type": "application/json",
			},
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (res.status === 401) continue;
		if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
		const json: any = await res.json();
		if (json.code !== undefined && json.code !== 200) {
			throw new Error(`API ${json.code}: ${json.msg ?? "error"}`);
		}
		return json.data ?? json;
	}
	throw new Error("HTTP 401: unauthorized");
}

async function resolveAuth(ctx: ExtensionContext): Promise<{ token?: string; base: string }> {
	let base = DEFAULT_BASE;
	let token: string | undefined;
	try {
		const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
		token = auth?.auth?.apiKey;
		const baseUrl = auth?.auth?.baseUrl;
		if (baseUrl) {
			try {
				const u = new URL(baseUrl);
				if (/(^|\.)z\.ai$|(^|\.)bigmodel\.cn$/.test(u.hostname)) {
					base = `${u.protocol}//${u.host}`;
				}
			} catch {
				// ignore malformed baseUrl, keep default
			}
		}
	} catch {
		// provider not configured — token stays undefined
	}
	return { token, base };
}

function usageRangeParams(days: number): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const fmt = (d: Date) =>
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
		`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
	const end = new Date();
	const start = new Date(end.getTime() - days * 24 * 3_600_000);
	return `startTime=${encodeURIComponent(fmt(start))}&endTime=${encodeURIComponent(fmt(end))}`;
}

export default function (pi: ExtensionAPI) {
	let usage: UsageData | undefined;
	let lastError: string | undefined;
	let lastAttemptAt = 0;
	let fetching = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let tickTimer: ReturnType<typeof setInterval> | undefined;
	let lastStatusText: string | undefined;

	function renderStatus(ctx: ExtensionContext, force = false) {
		if (!ctx.hasUI) return;
		const theme = ctx.ui.theme;
		let text: string;
		if (usage && usage.windows.length > 0) {
			const seg = (w: WindowInfo) =>
				theme.fg(colorFor(w.percentage), `${w.percentage ?? "?"}%`) + resetTag(theme, w);
			const short = usage.windows[0];
			const long = usage.windows[usage.windows.length - 1];
			text = `${theme.fg("dim", "zai")} ${theme.fg("muted", "⚡")} ${seg(short)}`;
			if (long && long !== short) text += theme.fg("dim", " · ") + seg(long);
		} else {
			text = theme.fg("error", `zai ⚠ ${lastError ?? "no data"}`);
		}
		// Local tick: skip the setStatus call when nothing visually changed.
		// Hour-resolution day tags only change on the hour, so they naturally
		// re-render hourly while minute-resolution tags tick every RENDER_TICK_MS.
		if (!force && text === lastStatusText) return;
		lastStatusText = text;
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	async function refresh(ctx: ExtensionContext): Promise<UsageData | undefined> {
		if (fetching) return usage;
		fetching = true;
		lastAttemptAt = Date.now();
		try {
			const { token, base } = await resolveAuth(ctx);
			if (!token) {
				lastError = `no API key for "${PROVIDER_ID}" (/login)`;
				renderStatus(ctx);
				return undefined;
			}
			const data = await apiGet(`${base}/api/monitor/usage/quota/limit`, token);
			usage = {
				level: data?.level,
				windows: windowsFromLimits(data?.limits),
				fetchedAt: Date.now(),
			};
			lastError = undefined;
			renderStatus(ctx);
			return usage;
		} catch (e) {
			lastError = e instanceof Error ? e.message : String(e);
			renderStatus(ctx);
			return undefined;
		} finally {
			fetching = false;
		}
	}

	pi.registerEntryRenderer<UsageEntryData>(
		"zai-usage",
		(entry, _options, theme) => {
			const d = entry.data ?? { windows: [], fetchedAt: Date.now() };
			const lines: string[] = [];
			lines.push(
				theme.fg("accent", theme.bold(`Z.ai GLM Coding Plan${d.level ? ` (${d.level})` : ""}`)),
			);
			for (const w of d.windows) {
				const pctText = typeof w.percentage === "number" ? `${w.percentage}%` : "?";
				const reset = fmtReset(w.resetAt);
				lines.push(
					`  ${theme.fg("muted", w.label.padEnd(15))}` +
						`${bar(theme, w.percentage)} ` +
						`${theme.fg(colorFor(w.percentage), pctText.padStart(4))}  ` +
						theme.fg("dim", `${fmtInt(w.used)} / ${fmtInt(w.total)} credits`) +
						(reset ? theme.fg("dim", ` — ${reset}`) : ""),
				);
			}
			if (d.sevenDay && (d.sevenDay.prompts || d.sevenDay.tokens)) {
				lines.push(
					`  ${theme.fg("muted", "7 days".padEnd(15))}` +
						theme.fg("dim", `${fmtInt(d.sevenDay.prompts)} requests · ${fmtTokens(d.sevenDay.tokens)} tokens`),
				);
			}
			if (d.error) lines.push(theme.fg("error", `  ${d.error}`));
			lines.push(theme.fg("dim", `  updated ${new Date(d.fetchedAt).toLocaleTimeString()}`));
			return new Text(lines.join("\n"), 0, 0);
		},
	);

	pi.registerCommand("zai-usage", {
		description: "Z.ai GLM Coding Plan usage (quota, reset times, 7-day stats)",
		handler: async (_args, ctx) => {
			const { token, base } = await resolveAuth(ctx);
			if (!token) {
				ctx.ui.notify(`zai-usage: no API key for "${PROVIDER_ID}" — run /login`, "error");
				return;
			}
			const [quota, sevenDay] = await Promise.allSettled([
				apiGet(`${base}/api/monitor/usage/quota/limit`, token),
				apiGet(`${base}/api/monitor/usage/model-usage?${usageRangeParams(7)}`, token),
			]);
			if (quota.status === "fulfilled") {
				lastAttemptAt = Date.now();
				usage = {
					level: quota.value?.level,
					windows: windowsFromLimits(quota.value?.limits),
					fetchedAt: Date.now(),
				};
				lastError = undefined;
			} else {
				lastError = quota.reason instanceof Error ? quota.reason.message : String(quota.reason);
			}
			const total = sevenDay.status === "fulfilled" ? sevenDay.value?.totalUsage : undefined;
			const data: UsageEntryData = {
				level: usage?.level,
				windows: usage?.windows ?? [],
				sevenDay: {
					prompts: total?.totalModelCallCount,
					tokens: total?.totalTokensUsage,
				},
				fetchedAt: usage?.fetchedAt ?? Date.now(),
				error: lastError,
			};
			renderStatus(ctx);
			pi.appendEntry<UsageEntryData>("zai-usage", data);
			if (!usage && ctx.hasUI) ctx.ui.notify(`zai-usage: ${lastError}`, "error");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		renderStatus(ctx, true);
		if (timer) clearInterval(timer);
		timer = setInterval(() => {
			void refresh(ctx).catch(() => {});
		}, REFRESH_MS);
		if (tickTimer) clearInterval(tickTimer);
		// Re-render the countdown from the cached resetAt — no API calls.
		tickTimer = setInterval(() => renderStatus(ctx), RENDER_TICK_MS);
		void refresh(ctx);
	});

	// Quota changed after a run; refresh, but not more often than SETTLED_REFRESH_MS.
	pi.on("agent_settled", async (_event, ctx) => {
		if (Date.now() - lastAttemptAt >= SETTLED_REFRESH_MS) void refresh(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		if (tickTimer) {
			clearInterval(tickTimer);
			tickTimer = undefined;
		}
		lastStatusText = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
