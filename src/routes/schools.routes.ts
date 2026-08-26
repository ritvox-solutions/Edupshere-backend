import { Router } from "express";
import {
  createSchool,
  getMySchool,
  updateMySchool,
  listSchools,
  getSchool,
  addSchoolAdmin,
  resetAdminPassword,
} from "../controllers/schools.controller";
import { authMiddleware } from "../middleware/auth";
import { asyncHandler } from "../lib/asyncHandler";

const router = Router();

router.get("/me", authMiddleware, asyncHandler(getMySchool));
router.patch("/me", authMiddleware, asyncHandler(updateMySchool));
router.get("/", authMiddleware, asyncHandler(listSchools));
router.post("/", authMiddleware, asyncHandler(createSchool));
router.get("/:id", authMiddleware, asyncHandler(getSchool));
router.post("/:id/admins", authMiddleware, asyncHandler(addSchoolAdmin));
router.post("/:id/admins/:profileId/reset-password", authMiddleware, asyncHandler(resetAdminPassword));

export { router as schoolsRouter };
