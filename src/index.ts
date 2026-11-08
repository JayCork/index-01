interface Env {
  DEDUPE: KVNamespace;
  INDEX_WEBHOOK_SECRET: string;
  TODOIST_TOKEN: string;
}

const MAX_SKEW_SECONDS = 300;
const DEDUPE_TTL_SECONDS = 86400;
const TODOIST_CONTENT_LIMIT = 500;

const enc = new TextEncoder();

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function signatureIsValid(
  secret: string,
  signatureHex: string,
  prefix: string,
  rawBody: ArrayBuffer,
): Promise<boolean> {
  const sig = hexToBytes(signatureHex);
  if (!sig) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const prefixBytes = enc.encode(prefix);
  const data = new Uint8Array(prefixBytes.length + rawBody.byteLength);
  data.set(prefixBytes, 0);
  data.set(new Uint8Array(rawBody), prefixBytes.length);
  // subtle.verify compares in constant time
  return crypto.subtle.verify("HMAC", key, sig, data);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/webhook") return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const h = request.headers;
    const version = h.get("X-Index-Webhook-Version") ?? "";
    const signature = h.get("X-Index-Signature") ?? "";
    const timestampText = h.get("X-Index-Timestamp") ?? "";
    const deliveryId = h.get("X-Index-Delivery") ?? "";
    const trigger = h.get("X-Index-Trigger") ?? "";
    const isTest = h.get("X-Index-Test") === "true";

    if (version !== "1") return new Response("Unsupported webhook version", { status: 400 });
    if (!/^\d+$/.test(timestampText)) return new Response("Invalid timestamp", { status: 400 });
    if (!deliveryId) return new Response("Missing delivery id", { status: 400 });

    const timestamp = parseInt(timestampText, 10);
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > MAX_SKEW_SECONDS) {
      return new Response("Expired request", { status: 401 });
    }

    const rawBody = await request.arrayBuffer();
    const prefix = `v${version}\n${timestamp}\n${deliveryId}\n${trigger}\n${isTest ? 1 : 0}\n`;
    if (!(await signatureIsValid(env.INDEX_WEBHOOK_SECRET, signature, prefix, rawBody))) {
      return new Response("Invalid signature", { status: 401 });
    }

    // Already handled this recording? Say OK so the app stops retrying.
    const dedupeKey = `d:${deliveryId}`;
    if (await env.DEDUPE.get(dedupeKey)) return new Response("Already received", { status: 200 });

    // Re-parse the multipart body we already read.
    let transcription = "";
    try {
      const form = await new Response(rawBody, {
        headers: { "Content-Type": h.get("Content-Type") ?? "" },
      }).formData();
      const value = form.get("transcription");
      if (typeof value === "string") transcription = value.trim();
    } catch {
      return new Response("Bad multipart body", { status: 400 });
    }

    if (!transcription) return new Response("Empty transcription, nothing to do", { status: 200 });

    const text = isTest ? `[test] ${transcription}` : transcription;
    const task: { content: string; description?: string } = {
      content: text.slice(0, TODOIST_CONTENT_LIMIT),
    };
    // Keep the full text if the title had to be cut.
    if (text.length > TODOIST_CONTENT_LIMIT) task.description = text;
    // No project_id: Todoist puts it in the Inbox.

    let res: Response;
    try {
      res = await fetch("https://api.todoist.com/api/v1/tasks", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.TODOIST_TOKEN}`,
          "Content-Type": "application/json",
          "X-Request-Id": deliveryId, // lets Todoist treat a repeat as the same request
        },
        body: JSON.stringify(task),
      });
    } catch (err) {
      console.error("Todoist unreachable", err);
      return new Response("Todoist unreachable", { status: 502 });
    }

    if (!res.ok) {
      console.error("Todoist failed", res.status, await res.text());
      // 5xx makes the app retry every minute. Never report success unless it is stored.
      return new Response("Todoist write failed", { status: 502 });
    }

    await env.DEDUPE.put(dedupeKey, "1", { expirationTtl: DEDUPE_TTL_SECONDS });
    return new Response("OK", { status: 200 });
  },
} satisfies ExportedHandler<Env>;
