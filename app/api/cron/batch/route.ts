import { runBatchJob } from "@/lib/batch/run-batch-job";
import { verifyQStashRequest } from "@/lib/qstash";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  if (!(await verifyQStashRequest(request))) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runBatchJob();
    return Response.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Batch failed";
    // A Neon quota block cannot recover within QStash's retry window. Return
    // success to stop retry fan-out; the next scheduled five-minute run will
    // resume automatically once the database is available again.
    if (isDatabaseQuotaError(message)) {
      console.error(`[batch] paused reason=database_quota_exceeded error=${message}`);
      return Response.json({ ok: false, paused: true, reason: "database_quota_exceeded" });
    }
    return Response.json(
      { ok: false, error: message },
      { status: 500 },
    );
  }
}

function isDatabaseQuotaError(message: string) {
  return /HTTP status 402|exceeded the quota|database_quota_exceeded/i.test(message);
}
