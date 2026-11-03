// Edge Function poll-subway: called by Supabase Cron every 15 s (pg_net, x-worker-secret header).
// Credentials come from the function's own environment on Supabase's servers and never leave it.
import { httpFetchFeed, runOnce, type Rpc } from "./worker.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";

function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try {
    return JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default ?? "";
  } catch {
    return "";
  }
}

// Constant-time comparison so the secret can't be guessed byte by byte from response timing.
function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const rpc: Rpc = async (fn, args) => {
  const key = serviceKey();
  const headers: Record<string, string> = { apikey: key, "Content-Type": "application/json" };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`; // legacy JWT key
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(args) });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = JSON.parse(text).message ?? text;
    } catch { /* plain text error */ }
    throw new Error(`${fn}: HTTP ${res.status} ${msg}`.slice(0, 300));
  }
  return text ? JSON.parse(text) : null;
};

Deno.serve(async (req) => {
  // Trim: secrets pasted into dashboards often carry a trailing newline or space
  const expected = (Deno.env.get("WORKER_SECRET") ?? "").trim();
  if (!expected) {
    console.error(JSON.stringify({ event: "config_error", message: "WORKER_SECRET is not set" }));
    return new Response(JSON.stringify({ error: "not configured" }), { status: 500 });
  }
  const provided = (req.headers.get("x-worker-secret") ?? "").trim();
  if (req.method !== "POST" || !safeEqual(provided, expected)) {
    // Server-side diagnostics only: lengths and character class, never the secret itself
    const raw = Deno.env.get("WORKER_SECRET") ?? "";
    console.warn(JSON.stringify({
      event: "auth_failed", method: req.method, provided_len: provided.length,
      expected_len: raw.length, expected_trimmed_len: expected.length, expected_hex: /^[0-9a-f]+$/.test(expected),
    }));
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const result = await runOnce({ fetchFeed: httpFetchFeed(), rpc });
  // One structured log line per run (Edge Function logs allow 100 events / 10 s)
  const line = JSON.stringify({ event: "poll-subway", ...result });
  if (result.status === "error") console.error(line);
  else console.log(line);
  return new Response(JSON.stringify(result), {
    status: result.status === "error" ? 500 : 200,
    headers: { "Content-Type": "application/json" },
  });
});
