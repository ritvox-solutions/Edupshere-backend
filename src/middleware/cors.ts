import { Express } from "express";

const allowedOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// Production frontend domains (Vercel prod/preview URLs) are added later via the
// CORS_ORIGINS env var in Render's dashboard, e.g.:
// CORS_ORIGINS=https://ritvox.vercel.app,https://ritvox-git-main.vercel.app
export function corsOptions(_app: Express) {
  return {
    origin(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin not allowed by CORS: ${origin}`));
      }
    },
    credentials: true,
  };
}
