import { Router } from "express";
import prisma from "../lib/prisma";
import { getScope } from "../lib/scope";
import { authMiddleware } from "../middleware/auth";

const router = Router();
router.use(authMiddleware);
function schoolIdGetter(){ return getScope().schoolId; }

router.get("/admin", async (req,res)=>{
  const schoolId = schoolIdGetter();
  const totalStudents = await prisma.student.count({ where:{ school_id:schoolId }});
  const totalStaff = await prisma.userRole.count({ where:{ school_id:schoolId, role:"teacher" }});
  const attendance = await prisma.attendanceRecord.findMany({ where:{ school_id:schoolId }});
  const attPct = attendance.length ? Math.round(attendance.filter(a=>a.status==="present").length/attendance.length*100) : 0;
  res.json({ totalStudents, totalStaff, todaysAttendance: `${attPct}%` });
});

router.get("/teacher", async (req,res)=>{
  const schoolId = schoolIdGetter();
  const userId = getScope().userId;
  const sections = await prisma.sectionSubject.findMany({ where:{ teacher_id:userId }, select:{ section:{ select:{ id:true, name:true } } }});
  res.json({ sections: sections.map(s=>s.section) });
});

router.get("/parent", async (req,res)=>{
  const userId = getScope().userId;
  const guardians = await prisma.studentGuardian.findMany({
    where:{ guardian_profile_id:userId },
    include:{ student:{ include:{ section:{ include:{ class:true } } } } },
  });
  const children = guardians.map(g=>g.student);

  const { child_id } = req.query;
  const selected = children.find(c=>c.id===child_id) ?? children[0];
  if (!selected) return res.json({ children, selected: null });

  const attendance = await prisma.attendanceRecord.findMany({
    where:{ student_id: selected.id },
    orderBy:{ date:"desc" },
    take: 30,
  });
  const attendancePct = attendance.length
    ? Math.round((attendance.filter(a=>a.status==="present").length / attendance.length) * 100)
    : null;

  const homework = selected.section_id
    ? await prisma.homework.findMany({ where:{ section_id: selected.section_id }, orderBy:{ due_date:"asc" }, take: 5 })
    : [];

  const feeStructures = selected.section?.class_id
    ? await prisma.feeStructure.findMany({ where:{ class_id: selected.section.class_id } })
    : [];

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
});

export { router as dashboardRouter };
