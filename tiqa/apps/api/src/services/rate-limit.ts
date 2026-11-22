import type { Redis } from "ioredis";
import { tooMany } from "../lib/errors";

/** Fixed one-minute window counter in Redis. Fails open if Redis is unavailable (availability > strictness). */
export async function hit(redis: Redis, bucket: string, limit: number, windowS = 60): Promise<{ remaining: number }> {
  const window = Math.floor(Date.now() / (windowS * 1000));
  const key = `tiqa:rl:${bucket}:${window}`;
  let count: number;
  try {
    const res = await redis.multi().incr(key).expire(key, windowS * 2).exec();
    count = Number(res?.[0]?.[1] ?? 0);
  } catch {
    return { remaining: limit };
  }
  if (count > limit) throw tooMany("RATE_LIMITED", { limit, window_seconds: windowS });
  return { remaining: limit - count };
}
