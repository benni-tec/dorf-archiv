import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { hcWithType } from "server/client";

export const Route = createFileRoute("/")({
	component: Index,
});

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3000";

const client = hcWithType(SERVER_URL);

// Inferred from the route handler rather than declared — the point of the RPC client.
// (Hono's own `InferResponseType` helper resolves to `never` for a handler that answers
// with more than one status, which this one does.)
type HealthResponse = Awaited<ReturnType<typeof client.health.$get>>;
type HealthReport = Awaited<ReturnType<HealthResponse["json"]>>;

const DEPENDENCY_LABELS: Record<keyof HealthReport["checks"], string> = {
	database: "Postgres",
	storage: "Object storage",
};

const STATUS_PRESENTATION: Record<
	HealthReport["status"],
	{ label: string; className: string }
> = {
	ok: {
		label: "All dependencies reachable",
		className: "bg-emerald-100 text-emerald-900",
	},
	degraded: {
		label: "Some dependencies unreachable",
		className: "bg-amber-100 text-amber-900",
	},
	down: {
		label: "No dependencies reachable",
		className: "bg-red-100 text-red-900",
	},
};

function Index() {
	const {
		data: report,
		error,
		isPending,
	} = useQuery({
		queryKey: ["health"],
		queryFn: async (): Promise<HealthReport> => {
			// A degraded server answers 503 with a perfectly good report, so the body is
			// what matters here, not the status code.
			const response = await client.health.$get();
			return await response.json();
		},
		refetchInterval: 10_000,
	});

	return (
		<main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 p-6">
			<header>
				<h1 className="text-4xl font-black tracking-tight">Dorf-Archiv</h1>
				<p className="text-neutral-600">
					Groundwork. No archive yet — this page exists to prove the server
					reaches its dependencies.
				</p>
			</header>

			{isPending && <p className="text-neutral-500">Checking…</p>}

			{error && (
				<p className="rounded-md bg-red-100 p-4 text-red-900">
					The server did not answer. Is it running, and are the dependencies up
					(<code className="font-mono">bun run dev:deps</code>)?
				</p>
			)}

			{report && (
				<section className="flex flex-col gap-3">
					<div
						className={`rounded-md px-4 py-3 font-semibold ${STATUS_PRESENTATION[report.status].className}`}
					>
						{STATUS_PRESENTATION[report.status].label}
					</div>

					<dl className="divide-y divide-neutral-200 rounded-md border border-neutral-200">
						{Object.entries(report.checks).map(([name, check]) => (
							<div
								key={name}
								className="flex items-baseline justify-between gap-4 px-4 py-3"
							>
								<dt className="font-medium">
									{DEPENDENCY_LABELS[name as keyof HealthReport["checks"]] ??
										name}
								</dt>
								<dd className="text-right text-sm">
									{check.status === "ok" ? (
										<span className="text-emerald-700">ok</span>
									) : (
										<span className="font-mono text-red-700">
											{check.detail}
										</span>
									)}
								</dd>
							</div>
						))}
					</dl>
				</section>
			)}
		</main>
	);
}
