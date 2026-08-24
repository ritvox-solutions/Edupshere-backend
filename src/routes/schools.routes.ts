import { Router } from "express";
import { createSchool, getMySchool, updateMySchool } from "../controllers/schools.controller";
import { authMiddleware } from "../middleware/auth";

const router = Router();

router.get("/me", authMiddleware, getMySchool);
router.patch("/me", authMiddleware, updateMySchool);
router.post("/", authMiddleware, createSchool);

export { router as schoolsRouter };
