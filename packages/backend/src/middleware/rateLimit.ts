import type { Request, Response, NextFunction, RequestHandler } from 'express';

interface Bucket {
  hits: number[];
}

/**
 * Simple in-memory sliding-window rate limiter. Enough to blunt brute-
 * force / DOS against sensitive endpoints when the backend runs as a
 * single instance on Railway. For multi-instance deploys, swap for a
 * Redis-backed limiter.
 *
 * Keyed by IP by default. Pass `keyFn` to key by authenticated user or
 * per-workspace.
 */
export function rateLimit(opts: {
  windowMs: number;
  max: number;
  keyFn?: (req: Request) => string;
  message?: string;
}): RequestHandler {
  const buckets = new Map<string, Bucket>();
  const { windowMs, max, keyFn, message = 'Too many requests, slow down.' } = opts;

  // Periodic GC so idle keys don't pile up.
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, bucket] of buckets) {
      bucket.hits = bucket.hits.filter((ts) => ts > cutoff);
      if (bucket.hits.length === 0) buckets.delete(key);
    }
  }, Math.max(windowMs, 30_000)).unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyFn ? keyFn(req) : req.ip ?? 'unknown';
    const now = Date.now();
    const cutoff = now - windowMs;
    const bucket = buckets.get(key) ?? { hits: [] };
    bucket.hits = bucket.hits.filter((ts) => ts > cutoff);
    if (bucket.hits.length >= max) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000).toString());
      return res.status(429).json({ success: false, error: message });
    }
    bucket.hits.push(now);
    buckets.set(key, bucket);
    next();
  };
}
