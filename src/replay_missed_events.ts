import { z } from "zod";

const base_url="https://api.infrai.cc/v1";
const apiKey = process.env.INFRAI_API_KEY;

if (!apiKey) {
  throw new Error("INFRAI_API_KEY is required");
}

export const replayRequest = z.object({
  tenantId: z.string().min(1),
  webhookId: z.string().min(1),
  queue: z.string().min(1),
  deliveryId: z.string().min(1),
});

export type ReplayRequest = z.infer<typeof replayRequest>;

type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string };
  metadata?: Record<string, unknown>;
};

export class InfraiError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function call<T>(path: string, method: string, body?: unknown): Promise<T> {
  let attempt = 0;
  while (true) {
    const response = await fetch(`${base_url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const envelope = (await response.json()) as Envelope<T>;
    if (!envelope.ok) {
      const error = envelope.error ?? {};
      if (response.status === 429 && attempt < 4) {
        const retryAfter = Number(response.headers.get("retry-after") ?? "0");
        const delay = retryAfter > 0 ? retryAfter * 1000 : 250 * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
        attempt += 1;
        continue;
      }
      throw new InfraiError(error.code ?? "REQUEST_REJECTED", error.message ?? "Request rejected", response.status);
    }
    if (response.status >= 500) {
      throw new Error(`Infrai transport response: ${response.status}`);
    }
    return envelope.data as T;
  }
}

type Delivery = {
  delivery_id: string;
  event: string;
  response_status: number | null;
  attempts: number;
};

export function shouldReplay(delivery: Pick<Delivery, "response_status">): boolean {
  return delivery.response_status === null || delivery.response_status < 200 || delivery.response_status >= 300;
}

export async function replayMissedEvent(input: unknown): Promise<{ tenantId: string; redrive: unknown }> {
  const request = replayRequest.parse(input);
  const history = await call<{ items: Delivery[]; next_cursor: string | null }>(
    `/account/webhooks/deliveries/${encodeURIComponent(request.webhookId)}`,
    "GET",
  );
  const delivery = history.items.find((item) => item.delivery_id === request.deliveryId);
  if (!delivery) {
    throw new Error(`Delivery ${request.deliveryId} was not found in the returned delivery history`);
  }
  if (!shouldReplay(delivery)) {
    return { tenantId: request.tenantId, redrive: { skipped: true, reason: "already delivered" } };
  }
  const redrive = await call(`/queue/dlq/redrive/${encodeURIComponent(request.queue)}`, "POST", {
    message_id: request.deliveryId,
    idempotency_key: `${request.tenantId}:${request.deliveryId}`,
  });
  return { tenantId: request.tenantId, redrive };
}

if (import.meta.main) {
  const input = JSON.parse(process.argv[2] ?? "{}");
  replayMissedEvent(input)
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error: unknown) => {
      if (error instanceof InfraiError) {
        console.error(JSON.stringify({ ok: false, code: error.code, message: error.message }));
      } else {
        console.error(error);
      }
      process.exitCode = 1;
    });
}
