#!/usr/bin/env node
// @ts-nocheck
/**
 * wobs-local — a dependency-free stdio MCP server for local Workers debugging.
 *
 * It connects to the *running* local explorer (wrangler dev) over HTTP and uses
 * the same D1 raw-query endpoint the UI uses, so there's a single writer to the
 * SQLite store (miniflare). It:
 *   - exposes debugging tools backed by the local trace store
 *   - enforces the access config set on the explorer's MCP page (log levels)
 *   - logs every tool call into `mcp_calls` so the dev sees what the agent did
 *
 * Output is shaped for agents (token-light, signal-dense): a compact verdict by
 * default, with a `detail: true` drill-down for the full span tree + attributes
 * when a complex fix needs it.
 *
 * Connect your agent by pointing it at:  node mcp-server.mjs
 * Configure the target explorer with:    WOBS_EXPLORER_URL (default :8799)
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdin/stdout (MCP stdio).
 * Nothing but protocol messages may be written to stdout — logs go to stderr.
 * NOTE: the raw-query endpoint rejects bound params in LIMIT/SELECT positions,
 * so (like the UI) we interpolate values with escaping instead.
 */

import readline from "node:readline";
import process from "node:process";

const EXPLORER_URL = (
	process.env.WOBS_EXPLORER_URL || "http://localhost:8799"
).replace(/\/$/, "");
const API = `${EXPLORER_URL}/cdn-cgi/explorer/api`;
const PROTOCOL_VERSION = "2024-11-05";

function logErr(...args) {
	process.stderr.write(`[wobs-mcp] ${args.join(" ")}\n`);
}

// ---- safe SQL value helpers (endpoint dislikes bound params) ----------------

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const int = (n, dflt, max) => {
	const v = Number(n);
	const safe = Number.isFinite(v) ? Math.floor(v) : dflt;
	return Math.max(1, Math.min(safe, max));
};

// ---- agent-friendly formatting (token-light, signal-dense) ------------------

const stripAnsi = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, "");

/** Turn a stored console message (JSON array, often with ANSI) into a clean string. */
function cleanMsg(raw) {
	if (raw == null) {
		return "";
	}
	let v = raw;
	try {
		v = JSON.parse(raw);
	} catch {
		// not JSON; treat as plain string
	}
	const flat = Array.isArray(v)
		? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")
		: typeof v === "string"
			? v
			: JSON.stringify(v);
	return stripAnsi(flat).trim();
}

function parseAttrs(str) {
	if (!str) {
		return {};
	}
	try {
		const o = JSON.parse(str);
		return o && typeof o === "object" ? o : {};
	} catch {
		return {};
	}
}

/** Pull the single most useful attribute (query text, url, key, ...) for a compact view. */
function keyAttr(attrs) {
	for (const k of [
		"db.query.text",
		"query",
		"sql",
		"url",
		"http.url",
		"http.request.url",
		"key",
		"rpcMethod",
	]) {
		if (attrs[k]) {
			return { detail: String(attrs[k]).slice(0, 200) };
		}
	}
	return {};
}

/** Collapse repeated sibling spans (e.g. an N+1 of 11 D1 calls) into one row. */
function groupSpans(spans) {
	const m = new Map();
	for (const s of spans) {
		const key = `${s.kind || ""}|${s.name || ""}`;
		const g = m.get(key) || { name: s.name, kind: s.kind, count: 0, total_ms: 0 };
		g.count += 1;
		g.total_ms += s.duration_ms || 0;
		m.set(key, g);
	}
	return [...m.values()]
		.map((g) => ({ ...g, total_ms: Math.round(g.total_ms) }))
		.sort((a, b) => b.total_ms - a.total_ms);
}

/** Drop null/undefined values and empty arrays/objects to save tokens. */
function prune(obj) {
	const out = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v == null) {
			continue;
		}
		if (Array.isArray(v) && v.length === 0) {
			continue;
		}
		if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) {
			continue;
		}
		out[k] = v;
	}
	return out;
}

// ---- explorer HTTP / D1 -----------------------------------------------------

let DB_ID = null;

async function apiGet(path) {
	const res = await fetch(`${API}${path}`);
	if (!res.ok) {
		throw new Error(`GET ${path} -> ${res.status}`);
	}
	return res.json();
}

async function discoverDbId() {
	const json = await apiGet(`/local/workers`);
	const workers = json?.result ?? [];
	for (const w of workers) {
		for (const d of w?.bindings?.d1 ?? []) {
			if (/trace/i.test(d.bindingName || "")) {
				return d.id;
			}
		}
	}
	throw new Error(
		"No trace D1 binding found. Is the dev server running with the collector?"
	);
}

async function sql(statement) {
	if (!DB_ID) {
		DB_ID = await discoverDbId();
	}
	const res = await fetch(`${API}/d1/database/${DB_ID}/raw`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ sql: statement }),
	});
	if (!res.ok) {
		throw new Error(`raw query -> ${res.status}`);
	}
	const json = await res.json();
	const result = json?.result?.[0];
	const cols = result?.results?.columns ?? [];
	const rows = result?.results?.rows ?? [];
	return rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
}

// ---- access config + audit --------------------------------------------------

async function getConfig() {
	try {
		const rows = await sql("SELECT config FROM mcp_config WHERE id = 1");
		if (rows[0]?.config) {
			return JSON.parse(rows[0].config);
		}
	} catch {
		// table may not exist yet
	}
	return {
		logLevels: { error: true, warn: true, info: true, log: true, debug: false },
		resources: {},
	};
}

function allowedLevels(cfg) {
	return Object.entries(cfg.logLevels || {})
		.filter(([, v]) => v)
		.map(([k]) => k);
}

let auditTableReady = false;
async function audit(tool, args, status, summary) {
	try {
		if (!auditTableReady) {
			await sql(
				"CREATE TABLE IF NOT EXISTS mcp_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, tool TEXT, args TEXT, result TEXT, status TEXT, created_at TEXT DEFAULT (datetime('now')))"
			);
			auditTableReady = true;
		}
		await sql(
			`INSERT INTO mcp_calls (tool, args, result, status) VALUES (${q(tool)}, ${q(
				JSON.stringify(args ?? {})
			)}, ${q(String(summary ?? "").slice(0, 20000))}, ${q(status)})`
		);
	} catch (e) {
		logErr("audit insert failed:", e.message);
	}
}

// ---- tools ------------------------------------------------------------------

const TOOLS = [
	{
		name: "list_recent_errors",
		description:
			"List recent traces that failed (HTTP status >= 500, a non-ok outcome, or a thrown error). Use this to find what just broke, then call explain_trace on a trace_id. Returns trace_id, operation, status, duration, and the error.",
		inputSchema: {
			type: "object",
			properties: {
				limit: { type: "number", description: "max rows (default 10)" },
			},
		},
		run: async ({ limit }) => {
			const rows = await sql(
				`SELECT trace_id, name, status_code, outcome, error, duration_ms, created_at
				 FROM traces
				 WHERE COALESCE(status_code, 0) >= 500
				    OR (outcome IS NOT NULL AND outcome != 'ok')
				    OR error IS NOT NULL
				 ORDER BY created_at DESC, ROWID DESC LIMIT ${int(limit, 10, 50)}`
			);
			return { count: rows.length, errors: rows };
		},
	},
	{
		name: "explain_trace",
		description:
			"Root-cause a single trace. Returns a compact verdict by default: whether it errored, where it failed, grouped spans (repeats collapsed), cleaned logs, any stack trace, and a one-line summary. Pass detail:true for the full ordered span tree with every attribute (query text, URLs, keys) and per-span log correlation — use that when a complex fix needs the inputs/outputs of each call.",
		inputSchema: {
			type: "object",
			properties: {
				trace_id: { type: "string", description: "the trace to explain" },
				detail: {
					type: "boolean",
					description:
						"include the full ordered span tree + all attributes + log span correlation",
				},
			},
			required: ["trace_id"],
		},
		run: async ({ trace_id, detail }, cfg) => {
			if (!trace_id) {
				throw new Error("trace_id is required");
			}
			const [trace] = await sql(
				`SELECT trace_id, root_span_id, name, status_code, outcome, error, duration_ms, span_count, created_at
				 FROM traces WHERE trace_id = ${q(trace_id)} LIMIT 1`
			);
			if (!trace) {
				return { found: false, trace_id };
			}
			const all = await sql(
				`SELECT span_id, parent_id, name, kind, start_ms, duration_ms, outcome, error, attributes
				 FROM spans WHERE trace_id = ${q(trace_id)} ORDER BY start_ms ASC`
			);
			const spans = all.filter((s) => s.span_id !== trace.root_span_id);
			const errored =
				(trace.status_code ?? 0) >= 500 ||
				(!!trace.outcome && trace.outcome !== "ok") ||
				!!trace.error;
			const grouped = groupSpans(spans);
			const failingRaw = spans.filter(
				(s) => s.error || (s.outcome && s.outcome !== "ok")
			);

			// logs (allowed levels only), cleaned + correlated to span
			const levels = allowedLevels(cfg);
			let logRows = [];
			if (levels.length) {
				const inList = levels.map(q).join(",");
				logRows = await sql(
					`SELECT level, message, span_id, ts_ms, seq FROM logs
					 WHERE trace_id = ${q(trace_id)} AND level IN (${inList})
					 ORDER BY seq ASC LIMIT 200`
				);
			}
			const logs = logRows.map((l) =>
				prune({
					level: l.level,
					at_ms: Math.round(l.ts_ms ?? 0),
					span_id: detail ? l.span_id : undefined,
					msg: cleanMsg(l.message),
				})
			);

			// stack is only present for uncaught exceptions (stashed in attributes)
			let stack;
			for (const s of all) {
				const a = parseAttrs(s.attributes);
				if (a["exception.stack"]) {
					stack = String(a["exception.stack"]);
					break;
				}
			}

			const failures = failingRaw.map((s) =>
				prune({
					name: s.name,
					kind: s.kind,
					error: s.error || `outcome: ${s.outcome}`,
					...keyAttr(parseAttrs(s.attributes)),
				})
			);

			// locate the failure
			let failed_at, reason;
			if (failingRaw.length) {
				failed_at = failingRaw[0].name;
				reason = failingRaw[0].error || `outcome: ${failingRaw[0].outcome}`;
			} else if (errored) {
				const errLog = logs.find((l) => l.level === "error");
				failed_at = grouped[0] ? `${grouped[0].name} (inferred)` : "unknown";
				reason = errLog ? errLog.msg : trace.error || `status ${trace.status_code}`;
			}

			const dur = Math.round(trace.duration_ms ?? 0);
			const summary = errored
				? `${trace.name} → ${trace.status_code ?? "?"} after ${dur}ms; failed at ${failed_at}${reason ? ` (${String(reason).slice(0, 140)})` : ""}`
				: `${trace.name} → ${trace.status_code ?? "ok"} in ${dur}ms, ${spans.length} spans`;

			const out = prune({
				found: true,
				errored,
				operation: trace.name,
				status: trace.status_code,
				outcome: trace.outcome,
				duration_ms: dur,
				error: trace.error,
				failed_at: errored ? failed_at : undefined,
				reason: errored && reason ? String(reason).slice(0, 300) : undefined,
				stack: stack
					? stack.split("\n").slice(0, detail ? 30 : 6).join("\n")
					: undefined,
				failures,
				spans: grouped,
				logs,
				note: levels.length
					? undefined
					: "All log levels disabled in MCP access config; no logs returned.",
				summary,
			});

			if (detail) {
				out.span_tree = spans.map((s) => {
					const a = parseAttrs(s.attributes);
					return prune({
						span_id: s.span_id,
						parent_id: s.parent_id,
						name: s.name,
						kind: s.kind,
						at_ms: Math.round(s.start_ms ?? 0),
						ms: Math.round(s.duration_ms ?? 0),
						outcome: s.outcome,
						error: s.error,
						attributes: a,
					});
				});
			}
			return out;
		},
	},
	{
		name: "search_logs",
		description:
			"Search console logs across recent requests by free text and/or level. Messages are cleaned (ANSI stripped, flattened). Only returns levels allowed in the MCP access config.",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "substring to match in message/operation",
				},
				level: { type: "string", description: "error|warn|info|log|debug" },
				limit: { type: "number" },
			},
		},
		run: async ({ query, level, limit }, cfg) => {
			const levels = allowedLevels(cfg);
			if (levels.length === 0) {
				return {
					denied: true,
					reason: "all log levels disabled in access config",
				};
			}
			let wanted = levels;
			if (level) {
				if (!levels.includes(level)) {
					return {
						denied: true,
						reason: `level '${level}' is not allowed by the access config`,
					};
				}
				wanted = [level];
			}
			let where = `level IN (${wanted.map(q).join(",")})`;
			if (query) {
				where += ` AND (message LIKE ${q(`%${query}%`)} OR operation LIKE ${q(
					`%${query}%`
				)})`;
			}
			const rows = await sql(
				`SELECT level, message, operation, trace_id, created_at FROM logs
				 WHERE ${where} ORDER BY created_at DESC, ROWID DESC LIMIT ${int(limit, 50, 200)}`
			);
			return {
				count: rows.length,
				logs: rows.map((r) =>
					prune({
						level: r.level,
						operation: r.operation,
						trace_id: r.trace_id,
						at: r.created_at,
						msg: cleanMsg(r.message),
					})
				),
			};
		},
	},
];

const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// ---- JSON-RPC / MCP plumbing ------------------------------------------------

function send(msg) {
	process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
	send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
	send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleToolCall(id, params) {
	const name = params?.name;
	const args = params?.arguments ?? {};
	const tool = TOOL_BY_NAME[name];
	if (!tool) {
		await audit(name || "unknown", args, "error", "unknown tool");
		return replyError(id, -32602, `Unknown tool: ${name}`);
	}
	try {
		const cfg = await getConfig();
		const result = await tool.run(args, cfg);
		const text = JSON.stringify(result, null, 2);
		await audit(name, args, result.denied ? "denied" : "ok", text);
		reply(id, { content: [{ type: "text", text }] });
	} catch (e) {
		await audit(name, args, "error", e.message);
		reply(id, {
			content: [{ type: "text", text: `Error: ${e.message}` }],
			isError: true,
		});
	}
}

async function handle(msg) {
	const { id, method, params } = msg;
	switch (method) {
		case "initialize":
			return reply(id, {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: "wobs-local", version: "0.2.0" },
			});
		case "notifications/initialized":
		case "initialized":
			return;
		case "ping":
			return reply(id, {});
		case "tools/list":
			return reply(id, {
				tools: TOOLS.map(({ name, description, inputSchema }) => ({
					name,
					description,
					inputSchema,
				})),
			});
		case "tools/call":
			return handleToolCall(id, params);
		default:
			if (id !== undefined) {
				replyError(id, -32601, `Method not found: ${method}`);
			}
	}
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
	const trimmed = line.trim();
	if (!trimmed) {
		return;
	}
	let msg;
	try {
		msg = JSON.parse(trimmed);
	} catch {
		logErr("could not parse line:", trimmed.slice(0, 120));
		return;
	}
	Promise.resolve(handle(msg)).catch((e) => logErr("handler error:", e.message));
});

logErr(`ready — explorer at ${EXPLORER_URL}`);
