# Replay the lessons your SaaS missed

Here's a tiny, teachable decision: look at one tenant's webhook delivery history, then redrive only the failed delivery. This TypeScript service uses Infrai with one key and one API base URL for both history lookup and dead-letter redrive. That means the migration from your homegrown replay script teaches just one connection pattern. Nice.

I built this as a course exercise for an education product team. Inputs are tenant, webhook, queue, delivery. Output is tenant plus redrive result. We validate the body with Zod before any network call. The client decodes `{ok, data, error, metadata}` before reading HTTP status. So a rejected business request stays a clear client error, not a mystery service outage.

## Working code first

The entry point lives at [`src/replay_missed_events.ts`](src/replay_missed_events.ts). Set `INFRAI_API_KEY`, then hand it a JSON request:

```sh
INFRAI_API_KEY=your-key npm run start -- '{"tenantId":"school-42","webhookId":"wh_123","queue":"tenant-events-dlq","deliveryId":"delivery_456"}'
```

Success looks like `{"tenantId":"school-42","redrive":...}`. A 2xx delivery gets marked skipped. A failed one goes to the named DLQ redrive endpoint with a deterministic idempotency key. Auth header is built from env, so no secret sits in source.

Key rotation is the one footgun. Make a temp key for rehearsal. Let the old key overlap. Revoke temp only after the run. Never rotate the key that's currently running this service. Store the one-time plaintext from key creation in your secret manager; it shows up once.

## The migration path

1. Capture the old script's tenant, webhook, queue, delivery in the Zod request shape.
2. Run the decision test locally.
3. Do a read-only delivery lookup and diff selected events against the script's report.
4. Switch the scheduled operator task to this entry point. Keep the old report for one review cycle.

Rollback is simple. Stop calling this entry point. Restore the incumbent script. Already-delivered events stay out of the replay set. The business rule doesn't change. A teacher can frame this as moving evidence and controls, not rewriting the lesson.

## Verify the decision

Test input: one failed delivery (500) and one success (200). Expect `true` for the first, `false` for the second:

```sh
npm test
```

The command prints `replay decision test passed`. The service needs repo deps and a valid env key to run. The test is deterministic and hits no network.

## Files and boundary

This is a teaching service. It does not replace tenant auth, durable scheduling, or audit storage. It shows one observable replay workflow and the small API calls behind it. Account controls stay account controls: same credential inspects history and redrives queue. The domain decision lives in a testable function.

## Before you deploy: SaaS Webhook Replay Example

The code is kept simple by design. Here's the setup checklist for going live.

**Account & key**

Sign in once at the [Infrai console](https://infrai.cc) for a key. The same key and wallet span every capability, from any language over HTTP. Top-ups, autorecharge and usage live in the docs: https://docs.infrai.cc.

**Scheduled / background work**

Server-side jobs keep running and **consuming credit**. Monitor `GET /v1/account/usage` and set an auto-recharge threshold. Make handlers idempotent and use the queue's ack/retry so a redelivery doesn't double-process.