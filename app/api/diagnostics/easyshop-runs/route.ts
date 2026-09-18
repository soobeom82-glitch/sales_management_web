import { easyShopRunsForKstRange } from "@/lib/db";
import { verifyQStashRequest } from "@/lib/qstash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The reported cancellation window, intentionally fixed to prevent this
// temporary diagnostic endpoint from becoming a general run-history API.
const FROM_KST = "2026-09-18 14:40:00";
const TO_KST = "2026-09-18 15:00:00";

export async function POST(request: Request) {
  if (!(await verifyQStashRequest(request))) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const runs = await easyShopRunsForKstRange(FROM_KST, TO_KST);
  console.info(`[diagnostics] easyshop window=${FROM_KST}-${TO_KST} runs=${JSON.stringify(runs)}`);
  return Response.json({
    ok: true,
    windowKst: `${FROM_KST} - ${TO_KST}`,
    runs,
  });
}
