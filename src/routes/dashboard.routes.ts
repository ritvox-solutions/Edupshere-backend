import { Router } from "express";
import prisma from "../lib/prisma";
import { getScope } from "../lib/scope";
import { authMiddleware } from "../middleware/auth";
import { asyncHandler } from "../lib/asyncHandler";

const router = Router();
router.use(authMiddleware);
function schoolIdGetter(){ return getScope()!.schoolId!; }

router.get("/admin", asyncHandler(async (req,res)=>{
  const schoolId = schoolIdGetter();
  const today = new Date(new Date().toISOString().slice(0, 10));
  // Aggregate today's attendance in the DB instead of pulling every record the
  // school has ever saved into Node and counting in JS.
  const [totalStudents, totalStaff, byStatus] = await Promise.all([
    prisma.student.count({ where:{ school_id:schoolId }}),
    prisma.userRole.count({ where:{ school_id:schoolId, role:"teacher" }}),
    prisma.attendanceRecord.groupBy({
      by: ["status"],
      where: { school_id: schoolId, date: today },
      _count: { _all: true },
    }),
  ]);
  const marked = byStatus.reduce((sum, r) => sum + r._count._all, 0);
  const present = byStatus.find(r => r.status === "present")?._count._all ?? 0;
  const attPct = marked ? Math.round((present / marked) * 100) : 0;
  res.json({ totalStudents, totalStaff, todaysAttendance: `${attPct}%` });
}));

router.get("/teacher", asyncHandler(async (req,res)=>{
  const userId = getScope()!.userId!;
  const sections = await prisma.sectionSubject.findMany({ where:{ teacher_id:userId }, select:{ section:{ select:{ id:true, name:true } } }}) as Array<{ section: { id: string; name: string } }>;
  res.json({ sections: sections.map(s=>s.section) });
}));

router.get("/parent", asyncHandler(async (req,res)=>{
  const userId = getScope()!.userId!;
  const guardians = await prisma.studentGuardian.findMany({
    where:{ guardian_profile_id:userId },
    include:{ student:{ include:{ section:{ include:{ class:true } } } } },
  }) as any[];
  const children = guardians.map(g=>g.student);

  const { child_id } = req.query;
  const selected = children.find(c=>c.id===child_id) ?? children[0];
  if (!selected) return res.json({ children, selected: null });

  // These three don't depend on each other — run them in one round-trip batch
  // instead of three sequential trips to the DB.
  const [attendance, homework, feeStructures] = await Promise.all([
    prisma.attendanceRecord.findMany({
      where:{ student_id: selected.id },
      orderBy:{ date:"desc" },
      take: 30,
    }),
    selected.section_id
      ? prisma.homework.findMany({ where:{ section_id: selected.section_id }, orderBy:{ due_date:"asc" }, take: 5 })
      : Promise.resolve([]),
    selected.section?.class_id
      ? prisma.feeStructure.findMany({ where:{ class_id: selected.section.class_id } })
      : Promise.resolve([]),
  ]);
  const attendancePct = attendance.length
    ? Math.round((attendance.filter(a=>a.status==="present").length / attendance.length) * 100)
    : null;

  res.json({
    children,
    selected: {
      ...selected,
      attendancePct,
      latestAttendance: attendance[0] ?? null,
      homework,
      feeStructures,
    },
  });
}));

export { router as dashboardRouter };
