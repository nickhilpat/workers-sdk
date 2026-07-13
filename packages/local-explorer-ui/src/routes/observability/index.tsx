import { Button, Table } from "@cloudflare/kumo";
import { PulseIcon } from "@phosphor-icons/react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { ResourceError } from "../../components/ResourceError";
import { fetchTraces, formatDuration } from "../../utils/observability";
import type { TraceSummary } from "../../utils/observability";

/** How many traces to fetch per page. */
const PAGE_SIZE = 100;
/** The store caps a single list request at 1000 rows. */
const MAX_TRACES = 1000;

export const Route = createFileRoute("/observability/")({
	component: TracesView,
	errorComponent: ResourceError,
	loader: async () => {
		const traces = await fetchTraces(PAGE_SIZE);
		return { traces, hasMore: traces.length === PAGE_SIZE };
	},
});

function ObservabilityIcon({ className }: { className?: string }): JSX.Element {
	return <PulseIcon className={className} />;
}

function TracesView(): JSX.Element {
	const loaderData = Route.useLoaderData();

	const [traces, setTraces] = useState<TraceSummary[]>(loaderData.traces);
	const [limit, setLimit] = useState(PAGE_SIZE);
	const [hasMore, setHasMore] = useState(loaderData.hasMore);
	const [loadingMore, setLoadingMore] = useState(false);

	// Reset when the route re-loads (e.g. navigating back to the list).
	useEffect(() => {
		setTraces(loaderData.traces);
		setLimit(PAGE_SIZE);
		setHasMore(loaderData.hasMore);
		setLoadingMore(false);
	}, [loaderData]);

	// "Load more" grows the fetch window (the API is newest-first). Older traces
	// are always stored; this surfaces more of them, up to the store's per-request
	// cap. (Browsing beyond MAX_TRACES needs offset pagination in the API.)
	const loadMore = useCallback(async (): Promise<void> => {
		const next = Math.min(limit + PAGE_SIZE, MAX_TRACES);
		setLoadingMore(true);
		try {
			const rows = await fetchTraces(next);
			setTraces(rows);
			setLimit(next);
			setHasMore(rows.length === next && next < MAX_TRACES);
		} finally {
			setLoadingMore(false);
		}
	}, [limit]);

	return (
		<>
			<Breadcrumbs icon={ObservabilityIcon} items={[]} title="Observability" />

			<div className="px-6 py-6">
				{traces.length === 0 ? (
					<div className="flex flex-col items-center justify-center space-y-2 p-12 text-center text-kumo-subtle">
						<h2 className="text-2xl font-medium">No traces captured yet</h2>
						<p className="text-sm font-light">
							Send a request to one of your workers to see its trace here.
						</p>
					</div>
				) : (
					<>
						<div className="overflow-hidden rounded-lg border border-kumo-fill">
							<Table>
								<Table.Header>
									<Table.Row>
										<Table.Head>Name</Table.Head>
										<Table.Head>Worker</Table.Head>
										<Table.Head>Spans</Table.Head>
										<Table.Head>Duration</Table.Head>
										<Table.Head>Outcome</Table.Head>
									</Table.Row>
								</Table.Header>
								<Table.Body>
									{traces.map((trace) => {
										// A root whose outcome hasn't landed is still running
										// (write-through capture surfaces it in-flight).
										const running =
											trace.outcome === null || trace.outcome === undefined;
										return (
											<Table.Row key={trace.trace_id}>
												<Table.Cell>
													<Link
														className="font-mono text-xs text-kumo-link hover:underline"
														params={{ traceId: trace.trace_id }}
														to="/observability/traces/$traceId"
													>
														{trace.name ?? trace.trace_id}
													</Link>
												</Table.Cell>
												<Table.Cell className="text-text-secondary text-xs">
													{trace.service ?? "—"}
													{(trace.service_count ?? 0) > 1
														? ` +${(trace.service_count ?? 1) - 1}`
														: ""}
												</Table.Cell>
												<Table.Cell className="text-xs">
													{trace.span_count ?? 0}
													{(trace.error_count ?? 0) > 0 ? (
														<span className="ml-1.5 text-kumo-danger">
															({trace.error_count} error
															{trace.error_count === 1 ? "" : "s"})
														</span>
													) : null}
												</Table.Cell>
												<Table.Cell className="text-text-secondary font-mono text-xs">
													{running
														? "running…"
														: formatDuration(trace.duration_ms)}
												</Table.Cell>
												<Table.Cell className="text-xs">
													<span
														className={
															running
																? "text-text-secondary"
																: trace.outcome === "ok"
																	? "text-kumo-default"
																	: "text-kumo-danger"
														}
													>
														{running ? "running…" : trace.outcome}
													</span>
												</Table.Cell>
											</Table.Row>
										);
									})}
								</Table.Body>
							</Table>
						</div>

						{hasMore ? (
							<div className="py-4 text-center">
								<Button
									variant="secondary"
									disabled={loadingMore}
									loading={loadingMore}
									onClick={loadMore}
								>
									{loadingMore ? "Loading..." : "Load more"}
								</Button>
							</div>
						) : null}
					</>
				)}
			</div>
		</>
	);
}
