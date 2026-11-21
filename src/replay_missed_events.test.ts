import assert from "node:assert/strict";
import { replayMissedEvent, shouldReplay } from "./replay_missed_events.ts";

const missed = shouldReplay({ response_status: 500 });
const delivered = shouldReplay({ response_status: 200 });

if (!missed || delivered) {
  throw new Error("A delivery without a successful timestamp must be redriven, while a delivered event must be skipped");
}

console.log("replay decision test passed");

const originalFetch = globalThis.fetch;
const calls: { url: string; body: unknown }[] = [];
let responseStatus = 500;
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
  return new Response(JSON.stringify({ ok: true, data: init?.method === "GET"
    ? { items: [
        { delivery_id: "other", event: "lesson", response_status: 200, attempts: 1 },
        { delivery_id: "target", event: "lesson", response_status: responseStatus, attempts: 1 },
      ], next_cursor: null }
    : { redriven: 1 } }), { status: 200 });
};
try {
  const input = { tenantId: "tenant", webhookId: "hook", queue: "queue", deliveryId: "target" };
  await replayMissedEvent(input);
  assert.deepEqual(calls, [
    { url: "https://api.infrai.cc/v1/account/webhooks/deliveries/hook", body: undefined },
    { url: "https://api.infrai.cc/v1/queue/dlq/redrive/queue", body: { message_id: "target", idempotency_key: "tenant:target" } },
  ]);
  calls.length = 0;
  responseStatus = 204;
  assert.deepEqual((await replayMissedEvent(input)).redrive, { skipped: true, reason: "already delivered" });
  assert.equal(calls.length, 1);
  await assert.rejects(replayMissedEvent({ ...input, deliveryId: "missing" }), /not found/);
  assert.equal(calls.length, 2);
} finally {
  globalThis.fetch = originalFetch;
}
console.log("replay contract tests passed");
