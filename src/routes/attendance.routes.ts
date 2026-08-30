import { Router } from "express";
import prisma from "../lib/prisma";
import { getScope } from "../lib/scope";
import { authMiddleware } from "../middleware/auth";
import { asyncHandler } from "../lib/asyncHandler";

const router = Router();
router.use(authMiddleware);

function schoolIdGetter() { return getScope()!.schoolId!; }

router.post("/", asyncHandler(async (req, res) => {
  const schoolId = schoolIdGetter();
  const { section_id, date, records } = req.body;
  if (!section_id || !date || !Array.isArray(records)) {
    return res.status(400).json({ error: "section_id, date, records array required" });
  }
  const scope = getScope()!;
  const userId = scope.userId!;
  const section = await prisma.section.findFirst({ where: { id: section_id } });
  if (!section) return res.status(400).json({ error: "section_id does not belong to this school" });
  if (scope.role !== "school_admin" && scope.role !== "super_admin") {
    const isClassTeacher = section.class_teacher_id === userId;
    if (!isClassTeacher) {
      const teacherSections = await prisma.sectionSubject.findMany({ where: { teacher_id: userId, section_id } });
      if (teacherSections.length === 0) return res.status(403).json({ error: "Not authorized for this section" });
    }
  }
  // One batched round-trip instead of two sequential writes per student.
  const day = new Date(date);
  const absentPayload = JSON.stringify({ date });
  await prisma.$transaction([
    ...records.map((r: { student_id: string; status: string }) =>
      prisma.attendanceRecord.upsert({
        where: { student_id_date: { student_id: r.student_id, date: day } },
        update: { status: r.status, section_id, school_id: schoolId },
        create: { school_id: schoolId, section_id, student_id: r.student_id, date: day, status: r.status },
      })
    ),
    prisma.notificationLog.createMany({
      data: records
        .filter((r: { status: string }) => r.status === "absent")
        .map((r: { student_id: string }) => ({
          school_id: schoolId,
          student_id: r.student_id,
          type: "attendance_absent",
          status: "queued",
          payload: absentPayload,
        })),
    }),
  ]);
  const results = records.map((r: { student_id: string; status: string }) => ({ student_id: r.student_id, status: r.status }));
  res.json({ results });
}));

router.get("/", asyncHandler(async (req, res) => {
  const schoolId = schoolIdGetter();
  const { section_id, date } = req.query;
  if (!section_id || !date) return res.status(400).json({ error: "section_id and date required" });
  const records = await prisma.attendanceRecord.findMany({
    where: { school_id: schoolId, section_id: String(section_id), date: new Date(String(date)) },
  });
  res.json(records);
}));

router.get("/summary", asyncHandler(async (req, res) => {
  const schoolId = schoolIdGetter();
  const { class_id, start_date, end_date, format } = req.query;
  const where: any = { school_id: schoolId };
  // AttendanceRecord only has a section_id scalar (no Prisma relation to
  // Section), so a class filter has to resolve section ids first rather than
  // using a nested relation filter, which Prisma rejects at the DB layer.
  if (class_id) {
    const sections = await prisma.section.findMany({ where: { class_id: String(class_id) }, select: { id: true } });
    where.section_id = { in: sections.map((s) => s.id) };
  }
  if (start_date && end_date) where.date = { gte: new Date(String(start_date)), lte: new Date(String(end_date)) };
  // Let Postgres do the counting instead of streaming every row into Node.
  const grouped = await prisma.attendanceRecord.groupBy({
    by: ["student_id", "status"],
    where,
    _count: { _all: true },
  });
  const totals: Record<string,{present:number,total:number}> = {};
  for (const g of grouped) {
    const t = (totals[g.student_id] ??= { present: 0, total: 0 });
    t.total += g._count._all;
    if (g.status === "present") t.present += g._count._all;
  }
  const summary = Object.entries(totals).map(([student_id,v])=>({ student_id, attendance_pct: Math.round(v.present/v.total*100) }));
  if (format==="csv") {
    const csv = "student_id,attendance_pct\n"+summary.map(s=>`${s.student_id},${s.attendance_pct}`).join("\n");
    res.setHeader("Content-Type","text/csv");
    return res.send(csv);
  }
  res.json(summary);
}));

export { router as attendanceRouter };
