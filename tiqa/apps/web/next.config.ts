import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const API_URL = process.env.API_URL ?? "http://localhost:4000";

const config: NextConfig = {
  // The browser only talks to /api/*, which is proxied to the Fastify API: same origin, so the
  // session cookie stays first-party (SameSite=Lax) and no CORS is needed.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_URL}/:path*` }];
  },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default createNextIntlPlugin("./src/i18n/request.ts")(config);
