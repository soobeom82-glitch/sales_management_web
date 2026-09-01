import { missingMonitorConfiguration } from "@/lib/config";

export const runtime = "nodejs";

export async function GET() {
  const missing = missingMonitorConfiguration();
  return Response.json({
    ok: missing.length === 0,
    missing,
    sources: [
      { source: "vmms", rule: "타입 99 또는 일괄 구매 거래" },
      { source: "easyshop", rule: "취소 거래" },
    ],
  });
}

