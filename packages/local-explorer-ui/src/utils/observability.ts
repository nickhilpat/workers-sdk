import { observabilityQuery } from "../api";

/**
 * The Observability store's only read endpoint is `POST /local/observability/query`
 * (read-only SQL returning `{ columns, rows }`). There are no typed per-view
 * routes, so these row shapes are defined here in the UI, and the common views
 * are the canned queries below. The `spans`/`logs` schema is the contract (it's
 * published in the endpoint's OpenAPI description).
 */
export interface Span {
	trace_id: string;
	span_id: string;
	parent_id?: string | null;
	service?: string | null;
	name?: string | null;
	kind?: string | null;
	start_ms?: number | null;
	duration_ms?: number | null;
	outcome?: string | null;
	error?: string | null;
	/** JSON string (the query wraps the JSONB column with `json(attributes)`). */
	attributes?: string | null;
}

/** A root span plus the per-trace aggregate counts from the trace-list query. */
export interface TraceSummary extends Span {
	span_count?: number;
	error_count?: number;
	service_count?: number;
}

export interface Log {
	trace_id: string;
	span_id?: string | null;
	seq: number;
	ts_ms?: number | null;
	level?: string | null;
	message?: string;
	operation?: string | null;
}

// Canned queries backing the Observability tab's views. They read the real
// column names and wrap the JSONB `attributes` column with `json(...)` so it
// comes back as a JSON string.
const TRACE_LIST_SQL = `SELECT trace_id, span_id, service, name, kind, start_ms, duration_ms, outcome,
		json(attributes) AS attributes,
		(SELECT COUNT(*) FROM spans s2 WHERE s2.trace_id = spans.trace_id) AS span_count,
		(SELECT COUNT(*) FROM spans s3 WHERE s3.trace_id = spans.trace_id AND s3.error IS NOT NULL) AS error_count,
		(SELECT COUNT(DISTINCT s4.service) FROM spans s4 WHERE s4.trace_id = spans.trace_id AND s4.service IS NOT NULL) AS service_count
	FROM spans WHERE parent_id IS NULL ORDER BY start_ms DESC LIMIT ?`;
const TRACE_SPANS_SQL = `SELECT trace_id, span_id, parent_id, service, name, kind, start_ms, duration_ms, outcome, error, json(attributes) AS attributes
	FROM spans WHERE trace_id = ? ORDER BY start_ms`;
const TRACE_LOGS_SQL = `SELECT trace_id, span_id, seq, ts_ms, level, message, operation
	FROM logs WHERE trace_id = ? ORDER BY ts_ms, seq`;

/** Run a read-only query and map the `{ columns, rows }` grid into row objects. */
async function runQuery<T>(sql: string, params: unknown[]): Promise<T[]> {
	const response = await observabilityQuery({
		body: { sql, params },
		throwOnError: true,
	});
	const result = response.data?.result;
	const columns = result?.columns ?? [];
	const rows = result?.rows ?? [];
	return rows.map((row) => {
		const obj: Record<string, unknown> = {};
		columns.forEach((col, i) => {
			obj[col] = row[i];
		});
		return obj as T;
	});
}

/** Recent invocations (root spans), newest first, with per-trace counts. */
export function fetchTraces(limit: number): Promise<TraceSummary[]> {
	return runQuery<TraceSummary>(TRACE_LIST_SQL, [limit]);
}

/** All spans for one trace, ordered by start time. */
export function fetchTraceSpans(traceId: string): Promise<Span[]> {
	return runQuery<Span>(TRACE_SPANS_SQL, [traceId]);
}

/** All logs for one trace, in order. */
export function fetchTraceLogs(traceId: string): Promise<Log[]> {
	return runQuery<Log>(TRACE_LOGS_SQL, [traceId]);
}

/** A span placed in the trace's waterfall: tree depth + timeline position. */
export interface WaterfallSpan {
	span: Span;
	depth: number;
	/** Left offset (0–100) of the span's bar within the trace window. */
	offsetPct: number;
	/** Width (0–100) of the span's bar within the trace window. */
	widthPct: number;
	/** True while the span is still running (`duration_ms` is NULL). */
	running: boolean;
}

/** A span is still running until its `duration_ms` lands (see write-through capture). */
export function isRunning(span: Span): boolean {
	return span.duration_ms === null || span.duration_ms === undefined;
}

/**
 * Under the Vite plugin your Worker runs inside a runner Durable Object behind a
 * few internal wrapper workers, so some tooling-only "wrapper" spans leak into
 * the trace. Capture doesn't tag them, so we recognise them by the Vite plugin's
 * internal worker/DO/path names. These are kept in sync by hand with
 * packages/vite-plugin-cloudflare (`constants.ts` / `shared.ts`); a stray miss
 * only means a wrapper span stays visible, never that a user span is hidden.
 */
const VITE_WRAPPER_MARKERS = [
	"__VITE_RUNNER_OBJECT__",
	"__router-worker__",
	"__asset-worker__",
	"__vite_proxy_worker__",
	"__vite_plugin_cloudflare", // init + get-export-types internal paths
];

/** True if the span comes from Vite's runner/wrapper plumbing, not user code. */
export function isViteWrapperSpan(span: Span): boolean {
	const haystack = `${span.service ?? ""} ${span.name ?? ""} ${span.attributes ?? ""}`;
	return VITE_WRAPPER_MARKERS.some((marker) => haystack.includes(marker));
}

/**
 * Order spans into a depth-first waterfall: each span nested under its parent
 * (by `parent_id`), siblings ordered by start time, with a timeline offset/width
 * relative to the whole trace's window. Spans whose parent isn't in the trace are
 * treated as roots (so nothing is dropped).
 */
export function buildWaterfall(spans: Span[]): WaterfallSpan[] {
	if (spans.length === 0) {
		return [];
	}

	let windowStart = Infinity;
	let windowEnd = -Infinity;
	for (const s of spans) {
		const start = s.start_ms ?? 0;
		// A running span has no end yet; its start still bounds the window so the
		// bar has an anchor, and it's drawn out to the current trace edge below.
		const end = start + (s.duration_ms ?? 0);
		windowStart = Math.min(windowStart, start);
		windowEnd = Math.max(windowEnd, end);
	}
	const window = Math.max(windowEnd - windowStart, 1);

	const ids = new Set(spans.map((s) => s.span_id));
	const childrenOf = new Map<string | null, Span[]>();
	for (const s of spans) {
		const parent = s.parent_id && ids.has(s.parent_id) ? s.parent_id : null;
		const siblings = childrenOf.get(parent) ?? [];
		siblings.push(s);
		childrenOf.set(parent, siblings);
	}
	for (const siblings of childrenOf.values()) {
		siblings.sort((a, b) => (a.start_ms ?? 0) - (b.start_ms ?? 0));
	}

	const out: WaterfallSpan[] = [];
	const seen = new Set<string>();
	function visit(parent: string | null, depth: number): void {
		for (const span of childrenOf.get(parent) ?? []) {
			if (seen.has(span.span_id)) {
				continue; // guard against cycles
			}
			seen.add(span.span_id);
			const start = span.start_ms ?? windowStart;
			const running = isRunning(span);
			const offsetPct = ((start - windowStart) / window) * 100;
			// A running span is drawn from its start out to the current edge of the
			// trace (we don't know its end yet); a finished span uses its duration.
			const widthPct = running
				? Math.max(100 - offsetPct, 0.5)
				: Math.max(((span.duration_ms ?? 0) / window) * 100, 0.5);
			out.push({ span, depth, offsetPct, widthPct, running });
			visit(span.span_id, depth + 1);
		}
	}
	visit(null, 0);
	return out;
}

/** Human-readable duration, e.g. `0ms`, `4.2ms`, `1.30s`. */
export function formatDuration(ms?: number | null): string {
	if (ms === undefined || ms === null || Number.isNaN(ms)) {
		return "—";
	}
	if (ms < 1000) {
		return `${Math.round(ms * 100) / 100}ms`;
	}
	return `${(ms / 1000).toFixed(2)}s`;
}

/** Parse the store's JSON-encoded `attributes` string into an object. */
export function parseAttributes(json?: string | null): Record<string, unknown> {
	if (!json) {
		return {};
	}
	try {
		const value = JSON.parse(json);
		return value && typeof value === "object"
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** Parse a JSON-encoded log message back to a display string. */
export function formatLogMessage(message?: string): string {
	if (message === undefined) {
		return "";
	}
	try {
		const value = JSON.parse(message);
		return typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		return message;
	}
}
