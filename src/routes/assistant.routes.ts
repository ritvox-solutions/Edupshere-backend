import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authMiddleware } from "../middleware/auth";
import { getScope } from "../lib/scope";
import { asyncHandler } from "../lib/asyncHandler";
import { runAssistantChat } from "../lib/assistant/agent";

const router = Router();
router.use(authMiddleware);

// Keyed by the authenticated user (not IP) since every caller here is already
// signed in — an IP-keyed limit would let one busy school throttle another's
// admins sharing the same NAT/office network.
const assistantLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as any).auth?.userId ?? req.ip,
});

const ALLOWED_ROLES = new Set(["super_admin", "school_admin", "teacher"]);

router.post("/chat", assistantLimiter, asyncHandler(async (req, res) => {
  const scope = getScope()!;
  if (!ALLOWED_ROLES.has(scope.role!)) {
    return res.status(403).json({ error: "Assistant not available for this role" });
  }
  const { message, history } = req.body;
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message required" });
  }

  const auth = { schoolId: scope.schoolId, role: scope.role!, userId: scope.userId! };
  try {
    const result = await runAssistantChat(auth, message, Array.isArray(history) ? history : undefined);
    res.json(result);
  } catch (err) {
    console.error("assistant chat failed:", err);
    res.status(502).json({ error: "Assistant is temporarily unavailable" });
  }
}));

export { router as assistantRouter };
