import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { parse } from "csv-parse/sync";
import prisma from "../lib/prisma";
import { getScope } from "../lib/scope";
import { authMiddleware } from "../middleware/auth";
import { toDate } from "../lib/dates";
import { asyncHandler } from "../lib/asyncHandler";
import * as bcrypt from "bcryptjs";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

function requireSchoolScope(req: Request, res: Response, next: NextFunction) {
  const scope = getScope();
  if (!scope?.schoolId) return res.status(401).json({ error: "Unauthorized" });
  next();
}

router.use(authMiddleware);
router.use(requireSchoolScope);
const schoolIdGetter = () => getScope()?.schoolId!;

// Classes CRUD
router.get("/classes", asyncHandler(async (req, res) => {
  const schoolId = schoolIdGetter();
  const classes = await prisma.class.findMany({ where: { school_id: schoolId }, orderBy: { display_order: "asc" } });
  res.json(classes);
}));

router.post("/classes", asyncHandler(async (req, res) => {
  const schoolId = schoolIdGetter();
  const { name, display_order } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  const cls = await prisma.class.create({ data: { school_id: schoolId, name, display_order: display_order ?? 0 } });
  res.status(201).json(cls);
}));

router.patch("/classes/:id", asyncHandler(async (req, res) => {
  const schoolId = schoolIdGetter();
  const { id } = req.params;
  const data = req.body;
  // The Prisma extension folds school_id into this where clause, so a class
  // belonging to another school simply won't match (P2025 -> 404), not leak.
  const cls = await prisma.class.update({ where: { id }, data: { ...data, school_id: schoolId } });
  res.json(cls);
}));

router.delete("/classes/:id", asyncHandler(async (req, res) => {
  const { id } = req.params;
  await prisma.class.delete({ where: { id } });
  res.status(204).send();
}));

// Sections CRUD
router.get("/sections", asyncHandler(async (req, res) => {
  const schoolId = schoolIdGetter();
  const sections = await prisma.section.findMany({ where: { school_id: schoolId }, include: { class: true } });
  res.json(sections);
}));

// Teachers
router.get("/teachers", asyncHandler(async (req, res) => {
  const schoolId = schoolIdGetter();
  const roles = await prisma.userRole.findMany({
    where: { school_id: schoolId, role: "teacher" },
    include: { user: { select: { id: true, full_name: true, email: true, phone: true } } },
  });
  res.json(roles.map((r) => r.user));
}));

router.post("/teachers", asyncHandler(async (req, res) => {
  const schoolId = schoolIdGetter();
  const { full_name, email, phone, password } = req.body;
  if (!full_name) return res.status(400).json({ error: "full_name required" });
  const password_hash = password ? await bcrypt.hash(password,10) : null;
  const profile = await prisma.profile.create({
    data: { full_name, email, phone, password_hash, preferred_language: "en" }
  });
  await prisma.userRole.create({ data: { user_id: profile.id, school_id: schoolId, role: "teacher" } });
  res.status(201).json({ id: profile.id });
}));

router.post("/teachers/bulk", upload.single("file"), asyncHandler(async (req, res) => {
  const schoolId = schoolIdGetter();
  if (!req.file) return res.status(400).json({ error: "CSV file required" });
  const records: any[] = parse(req.file.buffer.toString(), { columns: true, skip_empty_lines: true });
  const results = [];
  for (let i=0;i<records.length;i++) {
    const row = records[i];
    const errors = [];
    if (!row.full_name) errors.push("full_name missing");
    if (!row.email && !row.phone) errors.push("email or phone missing");
    if (errors.length) { results.push({ row: i+2, errors }); continue; }
    try {
      const profile = await prisma.profile.create({ data: { full_name: row.full_name, email: row.email || null, phone: row.phone || null, preferred_language: "en" } });
      await prisma.userRole.create({ data: { user_id: profile.id, school_id: schoolId, role: "teacher" } });
      results.push({ row: i+2, status: "created", id: profile.id });
    } catch (e: any) {
      results.push({ row: i+2, errors: [e.message] });
    }
  }
  res.json({ results });
}));

router.post("/sections", asyncHandler(async (req, res) => {
  const schoolId = schoolIdGetter();
  const { class_id, name, class_teacher_id } = req.body;
  if (!class_id || !name) return res.status(400).json({ error: "class_id and name required" });
  const cls = await prisma.class.findFirst({ where: { id: class_id } });
  if (!cls) return res.status(400).json({ error: "class_id does not belong to this school" });
  const sec = await prisma.section.create({ data: { school_id: schoolId, class_id, name, class_teacher_id } });
  res.status(201).json(sec);
}));

router.patch("/sections/:id", asyncHandler(async (req, res) => {
  const schoolId = schoolIdGetter();
  const { id } = req.params;
  const data = req.body;
  const sec = await prisma.section.update({ where: { id }, data: { ...data, school_id: schoolId } });
  res.json(sec);
}));

router.delete("/sections/:id", asyncHandler(async (req, res) => {
  const { id } = req.params;
  await prisma.section.delete({ where: { id } });
  res.status(204).send();
}));

// Students
router.get("/students", asyncHandler(async (req, res) => {
  const schoolId = schoolIdGetter();
  const { section_id } = req.query;
  const students = await prisma.student.findMany({
    where: { school_id: schoolId, ...(section_id ? { section_id: String(section_id) } : {}) },
    include: { section: { include: { class: true } } },
    orderBy: { full_name: "asc" },
  });
  res.json(students);
}));

router.post("/students", asyncHandler(async (req, res) => {
  const schoolId = schoolIdGetter();
  const { full_name, dob, section_id, roll_number, admission_date, guardian_phones } = req.body;
  if (!full_name || !section_id || !roll_number) return res.status(400).json({ error: "full_name, section_id, roll_number required" });
  const section = await prisma.section.findFirst({ where: { id: section_id } });
  if (!section) return res.status(400).json({ error: "section_id does not belong to this school" });
  const student = await prisma.student.create({ data: { school_id: schoolId, full_name, dob: toDate(dob), section_id, roll_number, admission_date: toDate(admission_date), status: "active" } });
  if (Array.isArray(guardian_phones)) {
    for (const phone of guardian_phones) {
      let guardian = await prisma.profile.findFirst({ where: { phone } });
      if (!guardian) {
        guardian = await prisma.profile.create({ data: { full_name: "Guardian", phone, preferred_language: "en" } });
        await prisma.userRole.create({ data: { user_id: guardian.id, school_id: schoolId, role: "parent" } });
      }
      await prisma.studentGuardian.create({ data: { student_id: student.id, guardian_profile_id: guardian.id, relationship: "guardian", is_primary_contact: true } });
    }
  }
  res.status(201).json({ id: student.id });
}));

router.post("/students/bulk", upload.single("file"), asyncHandler(async (req, res) => {
  const schoolId = schoolIdGetter();
  if (!req.file) return res.status(400).json({ error: "CSV file required" });
  const records: any[] = parse(req.file.buffer.toString(), { columns: true, skip_empty_lines: true });
  const results = [];
  for (let i=0;i<records.length;i++) {
    const row = records[i];
    const errors = [];
    if (!row.full_name) errors.push("full_name missing");
    if (!row.section_id) errors.push("section_id missing");
    if (!row.roll_number) errors.push("roll_number missing");
    if (errors.length) { results.push({ row: i+2, errors }); continue; }
    const section = await prisma.section.findFirst({ where: { id: row.section_id } });
    if (!section) { results.push({ row: i+2, errors: ["section_id does not belong to this school"] }); continue; }
    try {
      const student = await prisma.student.create({ data: { school_id: schoolId, full_name: row.full_name, dob: toDate(row.dob), section_id: row.section_id, roll_number: row.roll_number, admission_date: toDate(row.admission_date), status: "active" } });
      const guardians: string[] = (row.guardian_phones || "").split(",").map((p: string)=>p.trim()).filter(Boolean);
      for (const phone of guardians) {
        let guardian = await prisma.profile.findFirst({ where: { phone } });
        if (!guardian) {
          guardian = await prisma.profile.create({ data: { full_name: row.guardian_name || "Guardian", phone, preferred_language: "en" } });
          await prisma.userRole.create({ data: { user_id: guardian.id, school_id: schoolId, role: "parent" } });
        }
        await prisma.studentGuardian.create({ data: { student_id: student.id, guardian_profile_id: guardian.id, relationship: row.relationship || "guardian", is_primary_contact: true } });
      }
      results.push({ row: i+2, status: "created", id: student.id });
    } catch (e: any) {
      results.push({ row: i+2, errors: [e.message] });
    }
  }
  res.json({ results });
}));

// Fee structure
router.get("/fee-structures", asyncHandler(async (req, res) => {
  const schoolId = schoolIdGetter();
  const feeStructures = await prisma.feeStructure.findMany({ where: { school_id: schoolId }, orderBy: { created_at: "desc" } });
  res.json(feeStructures);
}));

router.post("/fee-structures", asyncHandler(async (req, res) => {
  const schoolId = schoolIdGetter();
  const { class_id, fee_head, amount, due_date, academic_year, installment_options } = req.body;
  if (!class_id || !fee_head || !amount) return res.status(400).json({ error: "class_id, fee_head, amount required" });
  const cls = await prisma.class.findFirst({ where: { id: class_id } });
  if (!cls) return res.status(400).json({ error: "class_id does not belong to this school" });
  const fs = await prisma.feeStructure.create({ data: { school_id: schoolId, class_id, fee_head, amount: Number(amount), due_date: toDate(due_date), academic_year, installment_options: installment_options ?? 1 } });
  res.status(201).json(fs);
}));

router.patch("/fee-structures/:id", asyncHandler(async (req, res) => {
  const schoolId = schoolIdGetter();
  const { id } = req.params;
  const existing = await prisma.feeStructure.findFirst({ where: { id, school_id: schoolId } });
  if (!existing) return res.status(404).json({ error: "Fee structure not found" });
  const { class_id, fee_head, amount, due_date, academic_year, installment_options } = req.body;
  const fs = await prisma.feeStructure.update({
    where: { id },
    data: {
      ...(class_id !== undefined && { class_id }),
      ...(fee_head !== undefined && { fee_head }),
      ...(amount !== undefined && { amount: Number(amount) }),
      ...(due_date !== undefined && { due_date: toDate(due_date) }),
      ...(academic_year !== undefined && { academic_year }),
      ...(installment_options !== undefined && { installment_options }),
    },
  });
  res.json(fs);
}));

router.delete("/fee-structures/:id", asyncHandler(async (req, res) => {
  const schoolId = schoolIdGetter();
  const { id } = req.params;
  const existing = await prisma.feeStructure.findFirst({ where: { id, school_id: schoolId } });
  if (!existing) return res.status(404).json({ error: "Fee structure not found" });
  await prisma.feeStructure.delete({ where: { id } });
  res.status(204).send();
}));

export { router as adminOnboardingRouter };
