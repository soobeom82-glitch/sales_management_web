import { config } from "@/lib/config";
import { dailyReportForDate } from "@/lib/db";
import { reconcileVmmsForDate } from "@/lib/monitor";

export const runtime = "nodejs";
export const maxDuration = 60;

// This protected recovery endpoint is intentionally separate from the daily
// report so an operator can replay a missed VMMS bulk-purchase alert safely.
export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!config.cronSecret || authorization !== `Bearer ${config.cronSecret}`) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const date = new URL(request.url).searchParams.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ ok: false, error: "date must use YYYY-MM-DD" }, { status: 400 });
  }

  try {
    const detail = new URL(request.url).searchParams.get("detail") === "1";
    const [result, dailyReport] = await Promise.all([
      reconcileVmmsForDate(date),
      detail ? dailyReportForDate(date) : Promise.resolve(null),
    ]);
    return Response.json({
      ok: true,
      date,
      scannedTransactions: Number(result.check.metadata?.scannedTransactions ?? 0),
      matchedTransactions: Number(result.check.metadata?.matchedTransactions ?? 0),
      insertedEvents: result.insertedEvents,
      telegramSent: result.telegramSent,
      ...(detail
        ? {
            transactions: result.check.sales.map((transaction) => ({
              occurredAt: transaction.occurredAt,
              amount: transaction.amount,
              transactionType: transaction.details.transactionType ?? null,
              status: transaction.status,
              product: transaction.productName,
            })),
            dailyReport: dailyReport
              ? {
                  status: dailyReport.status,
                  generatedAt: dailyReport.generatedAt,
                  sentAt: dailyReport.sentAt,
                  error: dailyReport.error,
                }
              : null,
          }
        : {}),
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "VMMS reconciliation failed" },
      { status: 500 },
    );
  }
}
