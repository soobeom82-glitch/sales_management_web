import { releaseJobLock, tryAcquireJobLock } from "@/lib/db";
import { runMonitor } from "@/lib/monitor";
import type { MonitorRunResult } from "@/lib/types";

const JOB_NAME = "sales-monitor";
// The Vercel route has a 60-second maximum duration. A four-minute lease blocks overlaps
// without keeping a failed invocation locked past the next five-minute schedule.
const LOCK_LEASE_SECONDS = 4 * 60;

export type BatchJobResult = {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  skipped: boolean;
  reason?: "already_running";
  processedCount: number;
  result?: MonitorRunResult;
};

export async function runBatchJob(): Promise<BatchJobResult> {
  const startedAt = new Date();
  const acquired = await tryAcquireJobLock(JOB_NAME, LOCK_LEASE_SECONDS);
  if (!acquired) {
    const finishedAt = new Date();
    console.info(`[batch] skipped reason=already_running startedAt=${startedAt.toISOString()} finishedAt=${finishedAt.toISOString()}`);
    return {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      skipped: true,
      reason: "already_running",
      processedCount: 0,
    };
  }

  let failureMessage: string | undefined;
  try {
    console.info(`[batch] started startedAt=${startedAt.toISOString()}`);
    const result = await runMonitor();
    const finishedAt = new Date();
    const processedCount = result.sources.reduce(
      (count, source) => count + Number(source.metadata?.scannedTransactions ?? 0),
      0,
    );
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    console.info(
      `[batch] completed startedAt=${startedAt.toISOString()} finishedAt=${finishedAt.toISOString()} ` +
        `durationMs=${durationMs} processed=${processedCount} inserted=${result.insertedEvents} telegramSent=${result.telegramSent}`,
    );
    return {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      skipped: false,
      processedCount,
      result,
    };
  } catch (error) {
    failureMessage = readableError(error);
    const finishedAt = new Date();
    console.error(
      `[batch] failed startedAt=${startedAt.toISOString()} finishedAt=${finishedAt.toISOString()} ` +
        `durationMs=${finishedAt.getTime() - startedAt.getTime()} error=${failureMessage}`,
    );
    throw error;
  } finally {
    await releaseJobLock(JOB_NAME, failureMessage).catch((error) => {
      console.error(`[batch] lock release failed error=${readableError(error)}`);
    });
  }
}

function readableError(error: unknown) {
  return error instanceof Error ? error.message : "알 수 없는 오류";
}
