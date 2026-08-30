import type { CorsOptions } from "cors";
import { Express } from "express";

// Comma-separated exact origins (scheme + host, no trailing slash). Set this in
// the backend's Vercel project settings for production, e.g.
//   CORS_ORIGINS=https://edusphere.vercel.app,https://app.myschool.com
// NOTE: env var changes on Vercel only take effect on the NEXT deployment.
const configuredOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);

const staticAllow = new Set<string>([
  "http://localhost:3000",
  "http://localhost:3001",
  ...configuredOrigins,
]);

// For every configured "https://<project>.vercel.app", also allow that
// project's Vercel preview deployments: "https://<project>-<branch/hash>.vercel.app".
const previewMatchers = configuredOrigins
  .map((o) => /^https:\/\/([a-z0-9-]+)\.vercel\.app$/i.exec(o)?.[1])
  .filter((name): name is string => Boolean(name))
  .map((name) => new RegExp(`^https://${name}-[a-z0-9-]+\\.vercel\\.app$`, "i"));

function isAllowedOrigin(origin: string): boolean {
  return staticAllow.has(origin) || previewMatchers.some((re) => re.test(origin));
}

export function corsOptions(_app: Express): CorsOptions {
  return {
    origin(origin, callback) {
      // No Origin header => same-origin or a non-browser client (curl, SSR,
      // health checks) — allow it through.
      if (!origin || isAllowedOrigin(origin)) return callback(null, true);
      // Disallowed: reply WITHOUT CORS headers rather than throwing. The browser
      // still blocks the response, but the preflight stays a clean 204 instead
      // of a 500 that looks like the server is down.
      return callback(null, false);
    },
    credentials: true,
  };
}
