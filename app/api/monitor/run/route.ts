import { config } from "@/lib/config";
import { runMonitor } from "@/lib/monitor";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!config.monitorAdminToken || authorization !== `Bearer ${config.monitorAdminToken}`) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runMonitor();
    return Response.json({ ok: true, result });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Monitor failed" },
      { status: 500 },
    );
  }
}

