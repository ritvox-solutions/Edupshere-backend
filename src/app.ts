import express, { Express } from "express";
import cors from "cors";
import * as Sentry from "@sentry/node";
import { corsOptions } from "./middleware/cors";
import { notFoundHandler, errorHandler } from "./middleware/error";

Sentry.init({ dsn: process.env.SENTRY_DSN });
import { healthRouter } from "./routes/health.routes";
import { authRouter } from "./routes/auth.routes";
import { schoolsRouter } from "./routes/schools.routes";
import { adminOnboardingRouter } from "./routes/admin.onboarding.routes";
import { attendanceRouter } from "./routes/attendance.routes";
import { academicsRouter } from "./routes/academics.routes";
import { dashboardRouter } from "./routes/dashboard.routes";
import { announcementsRouter } from "./routes/announcements.routes";

export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  Sentry.setupExpressErrorHandler(app);
  app.use(cors(corsOptions(app)));
  app.use(express.json({ limit: "1mb" }));

  app.use("/api/v1", healthRouter);
  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/schools", schoolsRouter);
  app.use("/api/v1/admin/onboarding", adminOnboardingRouter);
  app.use("/api/v1/attendance", attendanceRouter);
  app.use("/api/v1/academics", academicsRouter);
  app.use("/api/v1/dashboard", dashboardRouter);
  app.use("/api/v1/announcements", announcementsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

// Vercel's Node.js runtime imports this file directly as a serverless
// function and requires a default export it can invoke as (req, res) — an
// Express app instance satisfies that.
const app = createApp();
export default app;
