import { Table } from "@cloudflare/kumo";
import { PulseIcon } from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Breadcrumbs } from "../../../components/Breadcrumbs";
import { ResourceError } from "../../../components/ResourceError";
import {
	buildWaterfall,
	fetchTraceLogs,
	fetchTraceSpans,
	formatDuration,
	formatLogMessage,
	isViteWrapperSpan,
} from "../../../utils/observability";

export const Route = createFileRoute("/observability/traces/$traceId")({
	component: TraceDetailView,
	errorComponent: ResourceError,
	loader: async ({ params }) => {
		// Spans and logs live in separate tables, so the detail view is two
		// canned queries against the single /query endpoint.
		const [spans, logs] = await Promise.all([
			fetchTraceSpans(params.traceId),
			fetchTraceLogs(params.traceId),
		]);
		return { spans, logs };
	},
});

function ObservabilityIcon({ className }: { className?: string }): JSX.Element {
	return <PulseIcon className={className} />;
}

function TraceDetailView(): JSX.Element {
	const params = Route.useParams();
	const { spans, logs } = Route.useLoaderData();
	const [hideWrapperSpans, setHideWrapperSpans] = useState(true);
	// Only worth offering the toggle when the trace actually has Vite wrapper
	// spans (i.e. running under the Vite plugin); wrangler dev has none.
	const hasWrapperSpans = spans.some(isViteWrapperSpan);
	const visibleSpans =
		hasWrapperSpans && hideWrapperSpans
			? spans.filter((span) => !isViteWrapperSpan(span))
			: spans;
	const waterfall = buildWaterfall(visibleSpans);
	const root = waterfall.find((w) => w.depth === 0)?.span;

	return (
		<>
			<Breadcrumbs
				icon={ObservabilityIcon}
				items={[
					<span className="font-mono text-xs" key="trace">
						{root?.name ?? params.traceId}
					</span>,
				]}
				title="Observability"
			/>

			<div className="space-y-6 px-6 py-6">
				{waterfall.length === 0 ? (
					<div className="flex flex-col items-center justify-center space-y-2 p-12 text-center text-kumo-subtle">
						<h2 className="text-2xl font-medium">Trace not found</h2>
						<p className="text-sm font-light">
							This trace has no captured spans (it may have been cleared).
						</p>
					</div>
				) : (
					<>
						<section>
							<div className="mb-2 flex items-center justify-between">
								<h3 className="text-sm font-semibold text-kumo-default">
									Spans
								</h3>
								{hasWrapperSpans ? (
									<label className="text-text-secondary flex items-center gap-1.5 text-xs">
										<input
											checked={hideWrapperSpans}
											className="h-3 w-3"
											onChange={(e) => setHideWrapperSpans(e.target.checked)}
											type="checkbox"
										/>
										Hide Vite wrapper spans
									</label>
								) : null}
							</div>
							<div className="overflow-hidden rounded-lg border border-kumo-fill">
								{waterfall.map(
									({ span, depth, offsetPct, widthPct, running }) => {
										const failed =
											!running && (span.error != null || span.outcome !== "ok");
										return (
											<div
												className="flex items-center gap-3 border-b border-kumo-fill px-3 py-2 last:border-b-0"
												key={span.span_id}
											>
												<div
													className="flex min-w-0 shrink-0 flex-col"
													style={{
														paddingLeft: `${depth * 16}px`,
														width: "40%",
													}}
												>
													<span className="truncate text-xs text-kumo-default">
														{span.name ?? span.span_id}
													</span>
													<span className="text-text-secondary truncate text-[10px]">
														{span.kind ?? "span"}
														{span.service ? ` · ${span.service}` : ""}
													</span>
												</div>
												<div className="relative h-3 flex-1 rounded bg-kumo-tint">
													<div
														className={
															running
																? "bg-kumo-link absolute h-3 animate-pulse rounded opacity-60"
																: failed
																	? "absolute h-3 rounded bg-kumo-danger"
																	: "bg-kumo-link absolute h-3 rounded"
														}
														style={{
															marginLeft: `${offsetPct}%`,
															width: `${widthPct}%`,
														}}
													/>
												</div>
												<span className="text-text-secondary w-16 shrink-0 text-right font-mono text-[10px]">
													{running
														? "running…"
														: formatDuration(span.duration_ms)}
												</span>
											</div>
										);
									}
								)}
							</div>
						</section>

						<section>
							<h3 className="mb-2 text-sm font-semibold text-kumo-default">
								Logs
							</h3>
							{logs.length === 0 ? (
								<p className="text-sm text-kumo-subtle">
									No logs for this trace.
								</p>
							) : (
								<div className="overflow-hidden rounded-lg border border-kumo-fill">
									<Table>
										<Table.Header>
											<Table.Row>
												<Table.Head>Level</Table.Head>
												<Table.Head>Message</Table.Head>
											</Table.Row>
										</Table.Header>
										<Table.Body>
											{logs.map((log) => (
												<Table.Row key={`${log.trace_id}-${log.seq}`}>
													<Table.Cell className="text-xs">
														<span
															className={
																log.level === "error"
																	? "text-kumo-danger"
																	: log.level === "warn"
																		? "text-kumo-default"
																		: "text-text-secondary"
															}
														>
															{log.level ?? "log"}
														</span>
													</Table.Cell>
													<Table.Cell className="font-mono text-xs whitespace-pre-wrap">
														{formatLogMessage(log.message)}
													</Table.Cell>
												</Table.Row>
											))}
										</Table.Body>
									</Table>
								</div>
							)}
						</section>
					</>
				)}
			</div>
		</>
	);
}
