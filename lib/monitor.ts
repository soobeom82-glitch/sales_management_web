import { recordRun, reserveEventDelivery, storeSalesTransactions, updateTelegramDelivery } from "@/lib/db";
import { checkEasyShopCancellations } from "@/lib/sources/easyshop";
import { checkVmmsBulkPurchases } from "@/lib/sources/vmms";
import { sendTelegramAlert } from "@/lib/telegram";
import type { MonitorRunResult, SourceCheckResult } from "@/lib/types";

export async function runMonitor(): Promise<MonitorRunResult> {
  const startedAt = new Date().toISOString();
  const checks = await Promise.all([checkVmmsBulkPurchases(), checkEasyShopCancellations()]);
  let insertedEvents = 0;
  let telegramSent = 0;
  const deliveryErrors: string[] = [];

  for (const check of checks) {
    const finishedAt = new Date().toISOString();
    await storeSalesSafely(check);
    await recordRunSafely(check, startedAt, finishedAt);
    for (const event of check.events) {
      const id = await reserveEventDelivery(event);
      if (id === null) continue;
      insertedEvents += 1;
      try {
        await sendTelegramAlert(event);
        await updateTelegramDelivery(id, "sent");
        telegramSent += 1;
      } catch (error) {
        const message = readableError(error);
        await updateTelegramDelivery(id, "failed", message);
        deliveryErrors.push(`${check.source} 텔레그램 전송 실패: ${message}`);
      }
    }
  }

  const sourceErrors = checks
    .filter((check) => check.error)
    .map((check) => `${check.source} 조회 실패: ${check.error}`);
  const failures = [...sourceErrors, ...deliveryErrors];
  if (failures.length > 0) throw new Error(failures.join(" | "));

  return { startedAt, finishedAt: new Date().toISOString(), sources: checks, insertedEvents, telegramSent };
}

async function storeSalesSafely(check: SourceCheckResult) {
  try {
    await storeSalesTransactions(check.sales);
  } catch (error) {
    // Reporting depends on this durable ledger, so a failed write must be retried
    // by QStash rather than silently producing an incomplete daily report.
    throw new Error(`${check.source} 판매 원천 데이터를 저장하지 못했습니다: ${readableError(error)}`);
  }
}

async function recordRunSafely(check: SourceCheckResult, startedAt: string, finishedAt: string) {
  try {
    await recordRun(check, startedAt, finishedAt);
  } catch (error) {
    // A database error must stop the run because deduplication cannot be guaranteed.
    throw new Error(`실행 이력을 저장하지 못했습니다: ${readableError(error)}`);
  }
}

function readableError(error: unknown) {
  return error instanceof Error ? error.message : "알 수 없는 오류";
}
