import { Router } from "express";
import rateLimit from "express-rate-limit";
import { refreshToken, login } from "../controllers/auth.controller";
import { asyncHandler } from "../lib/asyncHandler";

const router = Router();

// Brute-force guard on credential-checking endpoints. Keyed by IP; the login
// endpoint is also the only place an attacker can cheaply probe passwords.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

// No public self-signup — accounts are created by a super admin (schools)
// or a school admin (staff/students), never by the person logging in.
router.post("/login", authLimiter, asyncHandler(login));
router.post("/refresh", asyncHandler(refreshToken));

export { router as authRouter };
