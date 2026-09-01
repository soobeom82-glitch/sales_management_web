import { insertEvent, recordRun, updateTelegramDelivery } from "@/lib/db";
import { checkEasyShopCancellations } from "@/lib/sources/easyshop";
import { checkVmmsBulkPurchases } from "@/lib/sources/vmms";
import { sendTelegramAlert } from "@/lib/telegram";
import type { MonitorRunResult, SourceCheckResult } from "@/lib/types";

export async function runMonitor(): Promise<MonitorRunResult> {
  const startedAt = new Date().toISOString();
  const checks = await Promise.all([checkVmmsBulkPurchases(), checkEasyShopCancellations()]);
  let insertedEvents = 0;
  let telegramSent = 0;

  for (const check of checks) {
    const finishedAt = new Date().toISOString();
    await recordRunSafely(check, startedAt, finishedAt);
    for (const event of check.events) {
      const id = await insertEvent(event);
      if (id === null) continue;
      insertedEvents += 1;
      try {
        await sendTelegramAlert(event);
        await updateTelegramDelivery(id, "sent");
        telegramSent += 1;
      } catch (error) {
        await updateTelegramDelivery(id, "failed", readableError(error));
      }
    }
  }

  return { startedAt, finishedAt: new Date().toISOString(), sources: checks, insertedEvents, telegramSent };
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

