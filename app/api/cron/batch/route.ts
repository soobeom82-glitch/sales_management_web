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
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Batch failed" },
      { status: 500 },
    );
  }
}
