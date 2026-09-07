import { config } from "@/lib/config";
import { runDailyReportJob } from "@/lib/reports/daily-report";

export const runtime = "nodejs";
export const maxDuration = 60;

// A 09:15 KST fallback. When the 09:00 run already sent the report, the
// durable daily_reports reservation returns `already_sent` without re-sending.
export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!config.cronSecret || authorization !== `Bearer ${config.cronSecret}`) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runDailyReportJob();
    return Response.json({ ok: true, retry: true, result });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Daily report retry failed" },
      { status: 500 },
    );
  }
}
