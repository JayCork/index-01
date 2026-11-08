# index-capture

A small Cloudflare Worker that turns a voice capture from a Pebble Index 01 ring into a raw task in the Todoist inbox.

It is deliberately dumb: it verifies the request, drops duplicates, and stores the transcript verbatim. No classification and no routing. Sorting happens later, at the end-of-day close.

## How it works

```
Ring (Hold & talk) -> Pebble app -> signed webhook -> this Worker -> Todoist inbox
```

For each request the Worker:

1. Checks the webhook version, timestamp (within 5 minutes) and HMAC-SHA256 signature.
2. Looks up the delivery ID in Workers KV and returns 200 if it has already been handled.
3. Reads the `transcription` field from the multipart body.
4. Creates a Todoist task with no project, which lands in the inbox.
5. Records the delivery ID in KV (24 hour expiry) and returns 200.

It returns success only after Todoist has accepted the task. If Todoist fails or can't be reached, it returns 502 and the Pebble app retries every minute, up to 10 attempts.

Tasks use the transcript as the title, cut at 500 characters. If it was cut, the full text goes in the description. Test events from the app are prefixed `[test]`.

## Requirements

- A Cloudflare account (the Workers Free plan is enough for this volume)
- Node.js (current LTS) and [pnpm](https://pnpm.io)
- A Todoist account and its personal API token
- A Pebble Index 01 with the Pebble mobile app

## Setup

1. Install dependencies:

   ```sh
   pnpm install
   ```

   `package.json` allows the `esbuild` and `workerd` build scripts, which pnpm 10 would otherwise skip.

2. Log in to Cloudflare:

   ```sh
   pnpm exec wrangler login
   ```

3. Create the duplicate-tracking store and paste the `id` it prints into `wrangler.jsonc`:

   ```sh
   pnpm exec wrangler kv namespace create DEDUPE
   ```

4. Generate a signing secret and keep it somewhere safe, because you need it again in the Pebble app:

   ```sh
   openssl rand -hex 32
   ```

5. Store the secrets. Each command prompts for the value:

   ```sh
   pnpm exec wrangler secret put INDEX_WEBHOOK_SECRET
   pnpm exec wrangler secret put TODOIST_TOKEN
   ```

   Find your Todoist token under Todoist Settings > Integrations > Developer.

6. Optionally add `"preview_urls": false` to `wrangler.jsonc`, so deployments don't get extra public preview addresses.

7. Deploy:

   ```sh
   pnpm deploy
   ```

   Wrangler prints your `workers.dev` address. The webhook endpoint is that address plus `/webhook`.

8. Configure the Pebble app: Settings > Webhook > **Hold & talk**.

   | Setting | Value |
   | --- | --- |
   | Webhook URL | `https://index-capture.<your-subdomain>.workers.dev/webhook` |
   | Sign requests | On, using the secret from step 4 |
   | Payload | Transcription only |

   Tap **Send test event**, then **Save**. A `[test]` task should appear in your Todoist inbox. Delete it.

## Configuration

| Name | Kind | Purpose |
| --- | --- | --- |
| `INDEX_WEBHOOK_SECRET` | Secret | HMAC signing secret, shared with the Pebble app |
| `TODOIST_TOKEN` | Secret | Todoist personal API token (full account access) |
| `DEDUPE` | KV binding | Remembers delivery IDs for 24 hours |

Never commit secrets. `.dev.vars` and `.env` are in `.gitignore`.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm typecheck` | Type-check with `tsc` |
| `pnpm dev` | Run locally with `wrangler dev` (needs a `.dev.vars` file with both secrets) |
| `pnpm deploy` | Deploy to Cloudflare |
| `pnpm tail` | Stream live logs from the deployed Worker |

## Operating it

- **Friday check:** open Recent runs in the Pebble app's webhook settings and look for failures. After 10 failed attempts the app stops retrying, but the run stays listed and you can press Retry.
- **Rotating the signing secret:** change it in both places, with `wrangler secret put INDEX_WEBHOOK_SECRET` and in the Pebble app. Until both match, requests fail with 401.
- **Regenerating the Todoist token:** the old one stops working immediately. Run `wrangler secret put TODOIST_TOKEN` with the new value.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| 401 Invalid signature | Secret differs between the app and the Worker, often a stray space or newline on paste |
| 401 Expired request | The phone's clock is more than 5 minutes out |
| 400 Unsupported webhook version | Pebble changed the webhook protocol version; check the Pebble webhook docs |
| 502 Todoist write failed | Todoist rejected the request, often a regenerated or wrong token |
| 502 Todoist unreachable | Todoist or the network was down; the app will retry |
| Error 1102 | The Free plan's 10 ms CPU limit was exceeded; the paid plan raises it |
| 405 when opening the URL in a browser | Expected. The endpoint only accepts POST |

## Limits and design choices

- A duplicate task is possible if Todoist accepts a task but the KV write then fails. The Worker passes the delivery ID to Todoist as a request ID to reduce this, but it is not a guarantee.
- The webhook fires alongside the Pebble app's own agent processing, so the app may also save its own copy of each recording (for example in Index Notes).
- Only the Hold & talk gesture is configured. Double click & hold has its own separate webhook settings.

## References

- [Pebble Index 01 webhooks](https://developer.repebble.com/index-01/webhooks.md)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits)
- [Todoist developer docs](https://developer.todoist.com)