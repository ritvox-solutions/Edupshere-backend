import { Router } from "express";
import { requestOtp, verifyOtp, refreshToken, signup, login } from "../controllers/auth.controller";

const router = Router();

router.post("/otp/request", requestOtp);
router.post("/otp/verify", verifyOtp);
router.post("/refresh", refreshToken);
router.post("/signup", signup);
router.post("/login", login);

export { router as authRouter };
