import cookie from "@fastify/cookie";
import Fastify, { type FastifyServerOptions } from "fastify";
import { ZodError } from "zod";
import type { Deps } from "./deps";
import { ApiError } from "./lib/errors";
import { authRoutes } from "./routes/auth";
import { dashboardRoutes } from "./routes/dashboard";
import { v1Routes } from "./routes/v1";
import { Network } from "./services/network";

declare module "fastify" {
  interface FastifyInstance {
    network: Network;
  }
}

/** Paths whose values must never reach the logs (phone numbers, credentials). */
export const LOG_REDACT = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  "res.headers['set-cookie']",
  "body.phone",
  "body.password",
  "body.csv",
];

export async function buildApp(deps: Deps, opts: { logger?: FastifyServerOptions["logger"] } = {}) {
  const app = Fastify({
    logger: opts.logger ?? { level: deps.env.LOG_LEVEL, redact: { paths: LOG_REDACT, censor: "[redacted]" } },
    trustProxy: true,
    bodyLimit: 256 * 1024,
    genReqId: () => crypto.randomUUID(),
  });
  const network = new Network(deps);
  app.decorate("network", network);

  await app.register(cookie, { secret: deps.env.SESSION_SECRET });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, details: err.details }, request_id: req.id });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: { code: "VALIDATION_FAILED" }, request_id: req.id });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode && e.statusCode < 500) {
      // Fastify errors (bad JSON, body too large, wrong content type…). Message never contains body content.
      return reply.code(e.statusCode).send({ error: { code: e.code ?? "BAD_REQUEST" }, request_id: req.id });
    }
    req.log.error({ err: { message: e.message, code: e.code } }, "unhandled error");
    return reply.code(500).send({ error: { code: "INTERNAL_ERROR" }, request_id: req.id });
  });

  app.get("/health", async () => {
    await deps.prisma.$queryRaw`SELECT 1`;
    await deps.redis.ping();
    return { ok: true };
  });

  await app.register(v1Routes, { deps, network });
  await app.register(authRoutes, { deps });
  await app.register(dashboardRoutes, { deps, network });

  return app;
}
