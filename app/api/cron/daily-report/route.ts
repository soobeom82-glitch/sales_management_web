import { config } from "@/lib/config";
import { runDailyReportJob } from "@/lib/reports/daily-report";
import { verifyQStashRequest } from "@/lib/qstash";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!config.cronSecret || authorization !== `Bearer ${config.cronSecret}`) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return executeDailyReport(request);
}

// Signed POST remains available for an intentional one-off QStash execution.
export async function POST(request: Request) {
  if (!(await verifyQStashRequest(request))) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return executeDailyReport(request);
}

async function executeDailyReport(request: Request) {
  const reportDate = new URL(request.url).searchParams.get("date") ?? undefined;
  try {
    const result = await runDailyReportJob(reportDate);
    return Response.json({ ok: true, result });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Daily report failed" },
      { status: 500 },
    );
  }
}
