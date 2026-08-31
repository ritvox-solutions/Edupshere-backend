import { Router } from "express";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middleware/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { getScope } from "../lib/scope";

// Board-aligned syllabus library. Global reference data (no school scoping).
// Reads are open to any authenticated user; writes are super-admin only.
// See 08_Lesson_Planner_Plan.md.
const router = Router();
router.use(authMiddleware);

function requireSuperAdmin(res: import("express").Response): boolean {
  if (getScope()?.role !== "super_admin") {
    res.status(403).json({ error: "Super admin only" });
    return false;
  }
  return true;
}

// ── Reads ──────────────────────────────────────────────────────────────────

router.get("/boards", asyncHandler(async (_req, res) => {
  const boards = await prisma.curriculumBoard.findMany({
    orderBy: [{ region: "asc" }, { name: "asc" }],
    select: { id: true, name: true, code: true, region: true },
  });
  res.json(boards);
}));

router.get("/subjects", asyncHandler(async (req, res) => {
  const { board_id, grade } = req.query;
  if (!board_id) return res.status(400).json({ error: "board_id required" });
  const subjects = await prisma.curriculumSubject.findMany({
    where: {
      board_id: String(board_id),
      ...(grade ? { grade: Number(grade) } : {}),
    },
    orderBy: [{ grade: "asc" }, { name: "asc" }],
    include: { _count: { select: { units: true } } },
  });
  res.json(
    subjects.map((s) => ({ id: s.id, board_id: s.board_id, grade: s.grade, name: s.name, unitCount: s._count.units })),
  );
}));

// Distinct subject names for a board — used by the school's subject picker so a
// school admin links "Maths" to the canonical "Mathematics".
router.get("/subject-names", asyncHandler(async (req, res) => {
  const { board_id } = req.query;
  if (!board_id) return res.status(400).json({ error: "board_id required" });
  const rows = await prisma.curriculumSubject.findMany({
    where: { board_id: String(board_id) },
    distinct: ["name"],
    orderBy: { name: "asc" },
    select: { name: true },
  });
  res.json(rows.map((r) => r.name));
}));

router.get("/subjects/:id", asyncHandler(async (req, res) => {
  const subject = await prisma.curriculumSubject.findUnique({
    where: { id: req.params.id },
    include: {
      board: { select: { id: true, name: true } },
      units: { orderBy: { sequence: "asc" } },
    },
  });
  if (!subject) return res.status(404).json({ error: "Curriculum subject not found" });
  res.json(subject);
}));

// ── Board CRUD (super admin) ───────────────────────────────────────────────

router.post("/boards", asyncHandler(async (req, res) => {
  if (!requireSuperAdmin(res)) return;
  const { name, code, region } = req.body ?? {};
  if (!name || !code) return res.status(400).json({ error: "name and code required" });
  try {
    const board = await prisma.curriculumBoard.create({
      data: { name: String(name).trim(), code: String(code).trim(), region: region ? String(region).trim() : null },
    });
    res.status(201).json(board);
  } catch {
    res.status(409).json({ error: "A board with this code already exists" });
  }
}));

router.patch("/boards/:id", asyncHandler(async (req, res) => {
  if (!requireSuperAdmin(res)) return;
  const { name, code, region } = req.body ?? {};
  const board = await prisma.curriculumBoard.update({
    where: { id: req.params.id },
    data: {
      ...(name !== undefined && { name: String(name).trim() }),
      ...(code !== undefined && { code: String(code).trim() }),
      ...(region !== undefined && { region: region ? String(region).trim() : null }),
    },
  });
  res.json(board);
}));

router.delete("/boards/:id", asyncHandler(async (req, res) => {
  if (!requireSuperAdmin(res)) return;
  await prisma.curriculumBoard.delete({ where: { id: req.params.id } });
  res.status(204).send();
}));

// ── Subject CRUD (super admin) ─────────────────────────────────────────────

router.post("/subjects", asyncHandler(async (req, res) => {
  if (!requireSuperAdmin(res)) return;
  const { board_id, grade, name } = req.body ?? {};
  if (!board_id || grade == null || !name) {
    return res.status(400).json({ error: "board_id, grade and name required" });
  }
  try {
    const subject = await prisma.curriculumSubject.create({
      data: { board_id: String(board_id), grade: Number(grade), name: String(name).trim() },
    });
    res.status(201).json(subject);
  } catch {
    res.status(409).json({ error: "That subject already exists for this board and grade" });
  }
}));

router.patch("/subjects/:id", asyncHandler(async (req, res) => {
  if (!requireSuperAdmin(res)) return;
  const { grade, name } = req.body ?? {};
  const subject = await prisma.curriculumSubject.update({
    where: { id: req.params.id },
    data: {
      ...(grade !== undefined && { grade: Number(grade) }),
      ...(name !== undefined && { name: String(name).trim() }),
    },
  });
  res.json(subject);
}));

router.delete("/subjects/:id", asyncHandler(async (req, res) => {
  if (!requireSuperAdmin(res)) return;
  await prisma.curriculumSubject.delete({ where: { id: req.params.id } });
  res.status(204).send();
}));

// ── Unit CRUD (super admin) ───────────────────────────────────────────────

router.post("/units", asyncHandler(async (req, res) => {
  if (!requireSuperAdmin(res)) return;
  const { curriculum_subject_id, title, sequence, description, term, suggested_periods } = req.body ?? {};
  if (!curriculum_subject_id || !title) {
    return res.status(400).json({ error: "curriculum_subject_id and title required" });
  }
  let seq = sequence;
  if (seq == null) {
    const last = await prisma.curriculumUnit.findFirst({
      where: { curriculum_subject_id: String(curriculum_subject_id) },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    seq = (last?.sequence ?? 0) + 1;
  }
  const unit = await prisma.curriculumUnit.create({
    data: {
      curriculum_subject_id: String(curriculum_subject_id),
      title: String(title).trim(),
      sequence: Number(seq),
      description: description ? String(description) : null,
      term: term == null || term === "" ? null : Number(term),
      suggested_periods: suggested_periods == null || suggested_periods === "" ? null : Number(suggested_periods),
    },
  });
  res.status(201).json(unit);
}));

router.patch("/units/:id", asyncHandler(async (req, res) => {
  if (!requireSuperAdmin(res)) return;
  const { title, sequence, description, term, suggested_periods } = req.body ?? {};
  const unit = await prisma.curriculumUnit.update({
    where: { id: req.params.id },
    data: {
      ...(title !== undefined && { title: String(title).trim() }),
      ...(sequence !== undefined && { sequence: Number(sequence) }),
      ...(description !== undefined && { description: description ? String(description) : null }),
      ...(term !== undefined && { term: term == null || term === "" ? null : Number(term) }),
      ...(suggested_periods !== undefined && {
        suggested_periods: suggested_periods == null || suggested_periods === "" ? null : Number(suggested_periods),
      }),
    },
  });
  res.json(unit);
}));

router.delete("/units/:id", asyncHandler(async (req, res) => {
  if (!requireSuperAdmin(res)) return;
  await prisma.curriculumUnit.delete({ where: { id: req.params.id } });
  res.status(204).send();
}));

export { router as curriculumRouter };
