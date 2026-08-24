import { Router } from "express";
import { healthController } from "../controllers/health.controller";

const router = Router();

// GET /api/v1/health
router.get("/health", healthController.check);

export { router as healthRouter };
