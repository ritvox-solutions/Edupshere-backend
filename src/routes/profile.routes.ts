import { Router } from "express";
import * as bcrypt from "bcryptjs";
import prisma, { Prisma } from "../lib/prisma";
import { getScope } from "../lib/scope";
import { authMiddleware } from "../middleware/auth";
import { asyncHandler } from "../lib/asyncHandler";

// The signed-in user's own account (any authenticated role). Distinct from
// /schools/me, which edits the school record — this only ever touches the
// caller's own Profile row, keyed by the userId in their token.
const router = Router();
router.use(authMiddleware);

const myId = () => getScope()!.userId!;

const profileSelect = {
  id: true,
  full_name: true,
  email: true,
  phone: true,
  username: true,
  preferred_language: true,
  created_at: true,
} satisfies Prisma.ProfileSelect;

router.get("/", asyncHandler(async (_req, res) => {
  const profile = await prisma.profile.findUnique({ where: { id: myId() }, select: profileSelect });
  if (!profile) return res.status(404).json({ error: "Profile not found" });
  res.json({ profile: { ...profile, role: getScope()!.role } });
}));

router.patch("/", asyncHandler(async (req, res) => {
  const { full_name, email, phone, preferred_language } = req.body ?? {};
  if (full_name !== undefined && !String(full_name).trim()) {
    return res.status(400).json({ error: "Name cannot be empty." });
  }
  const data: Prisma.ProfileUpdateInput = {
    ...(full_name !== undefined && { full_name: String(full_name).trim() }),
    ...(email !== undefined && { email: email ? String(email).trim() : null }),
    ...(phone !== undefined && { phone: phone ? String(phone).trim() : null }),
    ...(preferred_language !== undefined && { preferred_language }),
  };
  try {
    const profile = await prisma.profile.update({ where: { id: myId() }, data, select: profileSelect });
    res.json({ profile });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const field = (err.meta?.target as string[] | undefined)?.[0]?.replace(/_/g, " ") ?? "value";
      return res.status(409).json({ error: `That ${field} is already in use by another account.` });
    }
    throw err;
  }
}));

router.patch("/password", asyncHandler(async (req, res) => {
  const { current_password, new_password } = req.body ?? {};
  if (!current_password || !new_password) {
    return res.status(400).json({ error: "current_password and new_password are required." });
  }
  if (String(new_password).length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters." });
  }
  const profile = await prisma.profile.findUnique({ where: { id: myId() } });
  if (!profile?.password_hash) {
    return res.status(400).json({ error: "This account has no password set — ask an admin to reset it." });
  }
  const ok = await bcrypt.compare(current_password, profile.password_hash);
  if (!ok) return res.status(403).json({ error: "Current password is incorrect." });
  const password_hash = await bcrypt.hash(new_password, 10);
  await prisma.profile.update({ where: { id: profile.id }, data: { password_hash } });
  res.json({ ok: true });
}));

export { router as profileRouter };
