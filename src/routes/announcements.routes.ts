import { Router } from "express";
import prisma from "../lib/prisma";
import { getScope } from "../lib/scope";
import { authMiddleware } from "../middleware/auth";
import { asyncHandler } from "../lib/asyncHandler";

const router = Router();
router.use(authMiddleware);

router.get("/", asyncHandler(async (req, res) => {
  const scope = getScope()!;
  const list = await prisma.announcement.findMany({
    where: { school_id: scope.schoolId! },
    include: { author: { select: { full_name: true } } },
    orderBy: { created_at: "desc" },
    take: 50,
  });
  res.json(list);
}));

router.post("/", asyncHandler(async (req, res) => {
  const scope = getScope()!;
  if (!["school_admin", "teacher", "super_admin"].includes(scope.role!)) {
    return res.status(403).json({ error: "Not authorized to create announcements" });
  }
  const { title, body, audience_type, audience_id, priority, attachment_url } = req.body;
  if (!title || !body || !audience_type) {
    return res.status(400).json({ error: "title, body and audience_type required" });
  }
  const announcement = await prisma.announcement.create({
    data: {
      school_id: scope.schoolId!,
      author_id: scope.userId!,
      audience_type,
      audience_id: audience_id ?? null,
      title,
      body,
      priority: priority ?? "medium",
      attachment_url: attachment_url ?? null,
    },
    include: { author: { select: { full_name: true } } },
  });
  res.status(201).json(announcement);
}));

export { router as announcementsRouter };
