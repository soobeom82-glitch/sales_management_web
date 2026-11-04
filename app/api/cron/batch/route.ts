import { runBatchJob } from "@/lib/batch/run-batch-job";
import { verifyQStashRequest } from "@/lib/qstash";

export const runtime = "nodejs";
// External sales endpoints can respond slowly while the daily report is running.
// Keep the five-minute lock as the overlap guard, but allow a delayed run to finish.
export const maxDuration = 180;

export async function POST(request: Request) {
  if (!(await verifyQStashRequest(request))) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runBatchJob();
    return Response.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Batch failed";
    return Response.json(
      { ok: false, error: message },
      { status: 500 },
    );
  }
}
