import { config } from "@/lib/config";
import { runDailyReportJob } from "@/lib/reports/daily-report";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!config.monitorAdminToken || authorization !== `Bearer ${config.monitorAdminToken}`) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

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
