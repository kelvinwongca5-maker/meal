// Pipo Claude proxy — Cloudflare Worker.
// Deploy this file, add ANTHROPIC_API_KEY as a secret, then point the
// standalone HTML at your worker URL via window.__PIPO_PROXY_URL.

// Lock this down to your own domain(s) before sharing publicly.
// "*" means any origin can call the worker (fine for a private demo).
const ALLOWED_ORIGINS = ["*"];

// In-memory per-IP rate limit. Fine for a single-region personal demo;
// swap for Cloudflare's Rate Limiting binding for real production.
const RATE_LIMIT = { perMinute: 10, windowMs: 60_000 };
const hits = new Map();

function corsHeaders(origin) {
  const allow =
    ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)
      ? origin || "*"
      : "null";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE_LIMIT.windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_LIMIT.perMinute;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "POST") {
      return new Response("POST only", { status: 405, headers: cors });
    }

    const ip = request.headers.get("CF-Connecting-IP") || "anon";
    if (rateLimited(ip)) {
      return new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "bad_json" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Only allow a small, safe shape through — no server tools, no huge outputs.
    const payload = {
      model: body.model || "claude-haiku-4-5",
      max_tokens: Math.min(body.max_tokens || 400, 800),
      system: typeof body.system === "string" ? body.system : undefined,
      messages: Array.isArray(body.messages) ? body.messages : [],
    };

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  },
};
