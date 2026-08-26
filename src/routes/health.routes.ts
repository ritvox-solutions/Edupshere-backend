import { Router } from "express";
import { healthController } from "../controllers/health.controller";
import { asyncHandler } from "../lib/asyncHandler";

const router = Router();

// GET /api/v1/health
router.get("/health", asyncHandler(healthController.check));

export { router as healthRouter };
