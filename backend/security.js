// Abuse and cost protection for the public API. Every /api call can spend Azure OpenAI
// credit (a scored analysis also triggers several web searches), and CORS only stops
// browsers — a script can call the API directly. So: a per-client rate limit, plus a global
// daily ceiling as a circuit breaker for the team's Azure budget.
const DAY_MS = 24 * 60 * 60 * 1000;

// Azure App Service's front end forwards "ip:port" in X-Forwarded-For; without stripping the
// ephemeral port, every connection would look like a new client and the limit would do nothing.
function clientKey(req) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  return String(ip).replace(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/, "$1");
}

// Sliding-window limiter, in memory (single App Service instance — see server.js).
function createRateLimiter({ windowMs, max, now = Date.now }) {
  const hits = new Map(); // key -> [timestamps]
  const sweep = setInterval(() => {
    const cutoff = now() - windowMs;
    for (const [k, arr] of hits) {
      const kept = arr.filter((t) => t > cutoff);
      if (kept.length) hits.set(k, kept);
      else hits.delete(k);
    }
  }, Math.max(windowMs, 60_000));
  sweep.unref?.();

  return function rateLimit(req, res, next) {
    const key = clientKey(req);
    const t = now();
    const arr = (hits.get(key) || []).filter((x) => x > t - windowMs);
    if (arr.length >= max) {
      const retryAfter = Math.max(1, Math.ceil((arr[0] + windowMs - t) / 1000));
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({ error: "Too many requests. Please wait a moment and try again.", retry_after_seconds: retryAfter });
    }
    arr.push(t);
    hits.set(key, arr);
    next();
  };
}

// Global circuit breaker: at most `max` requests per UTC day across all clients.
function createDailyCap({ max, now = Date.now }) {
  let day = Math.floor(now() / DAY_MS);
  let count = 0;
  return function dailyCap(_req, res, next) {
    const d = Math.floor(now() / DAY_MS);
    if (d !== day) {
      day = d;
      count = 0;
    }
    if (count >= max) {
      return res.status(503).json({ error: "The assistant has reached today's usage limit. Please try again tomorrow." });
    }
    count += 1;
    next();
  };
}

// Baseline headers for a JSON-only API.
function securityHeaders(_req, res, next) {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  });
  next();
}

// JSON errors only — never Express's default HTML page, which can include a stack trace.
function jsonErrorHandler(err, _req, res, _next) {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error("Unhandled error", err);
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: status === 413 ? "Request too large." : status === 400 ? "Malformed request." : "Server error.",
  });
}

function notFound(_req, res) {
  res.status(404).json({ error: "Not found." });
}

module.exports = { createRateLimiter, createDailyCap, securityHeaders, jsonErrorHandler, notFound, clientKey };
