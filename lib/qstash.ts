import { Receiver } from "@upstash/qstash";
import { config } from "@/lib/config";

export async function verifyQStashRequest(request: Request): Promise<boolean> {
  // A local curl command remains useful during development. This bypass never applies to Vercel.
  if (process.env.NODE_ENV === "development") return true;

  if (!config.qstashCurrentSigningKey || !config.qstashNextSigningKey) {
    console.error("[batch] QStash signing keys are not configured");
    return false;
  }

  const signature = request.headers.get("upstash-signature");
  if (!signature) return false;

  try {
    const receiver = new Receiver({
      currentSigningKey: config.qstashCurrentSigningKey,
      nextSigningKey: config.qstashNextSigningKey,
    });
    return await receiver.verify({
      signature,
      body: await request.text(),
      url: request.url,
    });
  } catch (error) {
    console.warn(`[batch] invalid QStash signature error=${readableError(error)}`);
    return false;
  }
}

function readableError(error: unknown) {
  return error instanceof Error ? error.message : "알 수 없는 오류";
}
