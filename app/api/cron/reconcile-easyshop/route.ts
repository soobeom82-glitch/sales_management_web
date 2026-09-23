import { config } from "@/lib/config";
import { reconcileEasyShopForDate } from "@/lib/monitor";
import { verifyQStashRequest } from "@/lib/qstash";

export const runtime = "nodejs";
export const maxDuration = 60;

// Replays one whole EasyShop business day. Event fingerprints ensure an
// existing cancellation is never sent to Telegram twice.
export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!config.cronSecret || authorization !== `Bearer ${config.cronSecret}`) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  return reconcileEasyShop(request);
}

// This gives operators a safe QStash Request Builder path to replay one
// calendar day without needing to disclose CRON_SECRET in the browser.
export async function POST(request: Request) {
  if (!(await verifyQStashRequest(request))) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  return reconcileEasyShop(request);
}

async function reconcileEasyShop(request: Request) {
  const date = new URL(request.url).searchParams.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ ok: false, error: "date must use YYYY-MM-DD" }, { status: 400 });
  }

  try {
    const result = await reconcileEasyShopForDate(date);
    return Response.json({
      ok: true,
      date,
      scannedTransactions: Number(result.check.metadata?.scannedTransactions ?? 0),
      matchedTransactions: Number(result.check.metadata?.matchedTransactions ?? 0),
      insertedEvents: result.insertedEvents,
      telegramSent: result.telegramSent,
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "EasyShop reconciliation failed" },
      { status: 500 },
    );
  }
}
