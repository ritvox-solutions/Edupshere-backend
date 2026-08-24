import { Router } from "express";
import prisma from "../lib/prisma";
import { getScope } from "../lib/scope";
import { authMiddleware } from "../middleware/auth";

const router = Router();
router.use(authMiddleware);

function schoolIdGetter() { return getScope()!.schoolId!; }

router.post("/", async (req, res) => {
  const schoolId = schoolIdGetter();
  const { section_id, date, records } = req.body;
  if (!section_id || !date || !Array.isArray(records)) {
    return res.status(400).json({ error: "section_id, date, records array required" });
  }
  const scope = getScope()!;
  const userId = scope.userId!;
  if (scope.role !== "school_admin" && scope.role !== "super_admin") {
    const section = await prisma.section.findUnique({ where: { id: section_id }, select: { class_teacher_id: true } });
    const isClassTeacher = section?.class_teacher_id === userId;
    if (!isClassTeacher) {
      const teacherSections = await prisma.sectionSubject.findMany({ where: { teacher_id: userId, section_id } });
      if (teacherSections.length === 0) return res.status(403).json({ error: "Not authorized for this section" });
    }
  }
  const results = [];
  for (const r of records) {
    const { student_id, status } = r;
    await prisma.attendanceRecord.upsert({
      where: { student_id_date: { student_id, date: new Date(date) } },
      update: { status, section_id, school_id: schoolId },
      create: { school_id: schoolId, section_id, student_id, date: new Date(date), status }
    });
    if (status === "absent") {
      await prisma.notificationLog.create({ data: { school_id: schoolId, student_id, type: "attendance_absent", status: "queued", payload: JSON.stringify({ date }) } });
    }
    results.push({ student_id, status });
  }
  res.json({ results });
});

router.get("/", async (req, res) => {
  const schoolId = schoolIdGetter();
  const { section_id, date } = req.query;
  if (!section_id || !date) return res.status(400).json({ error: "section_id and date required" });
  const records = await prisma.attendanceRecord.findMany({
    where: { school_id: schoolId, section_id: String(section_id), date: new Date(String(date)) },
  });
  res.json(records);
});

router.get("/summary", async (req, res) => {
  const schoolId = schoolIdGetter();
  const { class_id, start_date, end_date, format } = req.query;
  const where: any = { school_id: schoolId };
  if (class_id) where.section = { class_id: String(class_id) };
  if (start_date && end_date) where.date = { gte: new Date(String(start_date)), lte: new Date(String(end_date)) };
  const records = await prisma.attendanceRecord.findMany({ where, select: { student_id: true, date: true, status: true, section_id: true } });
  const totals: Record<string,{present:number,total:number}> = {};
  for (const r of records) {
    if (!totals[r.student_id]) totals[r.student_id] = { present:0,total:0 };
    totals[r.student_id].total++;
    if (r.status === "present") totals[r.student_id].present++;
  }
  const summary = Object.entries(totals).map(([student_id,v])=>({ student_id, attendance_pct: Math.round(v.present/v.total*100) }));
  if (format==="csv") {
    const csv = "student_id,attendance_pct\n"+summary.map(s=>`${s.student_id},${s.attendance_pct}`).join("\n");
    res.setHeader("Content-Type","text/csv");
    return res.send(csv);
  }
  res.json(summary);
});

export { router as attendanceRouter };
