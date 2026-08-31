import { Router } from "express";
import multer from "multer";
import prisma from "../lib/prisma";
import { getScope } from "../lib/scope";
import { authMiddleware } from "../middleware/auth";
import { toDate } from "../lib/dates";
import { asyncHandler } from "../lib/asyncHandler";
import { generateLessonPlan } from "../lib/lessonPlanAI";

const router = Router();
router.use(authMiddleware);
const upload = multer({ storage: multer.memoryStorage() });

function schoolIdGetter(){ return getScope()!.schoolId!; }

// Section/Subject/Class all carry school_id and are auto-scoped by the Prisma
// extension, so a findFirst on any of them returns null if it belongs to a
// different school — that's what makes these checks a real tenant boundary.
async function assertSectionAndSubjectInSchool(section_id: string, subject_id: string) {
  const [section, subject] = await Promise.all([
    prisma.section.findFirst({ where: { id: section_id } }),
    prisma.subject.findFirst({ where: { id: subject_id } }),
  ]);
  return Boolean(section && subject);
}

async function assertTeacherInSchool(teacher_id: string, schoolId: string) {
  const role = await prisma.userRole.findFirst({ where: { user_id: teacher_id, school_id: schoolId, role: "teacher" } });
  return Boolean(role);
}

router.post("/timetable", asyncHandler(async (req,res)=>{
  const schoolId = schoolIdGetter();
  const {section_id,subject_id,teacher_id,day_of_week,start_time,end_time}=req.body;
  if (!section_id || !subject_id || !teacher_id) {
    return res.status(400).json({ error: "section_id, subject_id and teacher_id required" });
  }
  const [validSectionSubject, validTeacher] = await Promise.all([
    assertSectionAndSubjectInSchool(section_id, subject_id),
    assertTeacherInSchool(teacher_id, schoolId),
  ]);
  if (!validSectionSubject || !validTeacher) {
    return res.status(400).json({ error: "section, subject or teacher does not belong to this school" });
  }
  const entry = await prisma.timetableEntry.create({ data:{ school_id:schoolId, section_id, subject_id, teacher_id, day_of_week,start_time,end_time }});
  // Scheduling a class implies the teacher is assigned to it — keep the assignment table in sync
  // so attendance/homework authorization (which checks SectionSubject) doesn't diverge from the schedule.
  const existingAssignment = await prisma.sectionSubject.findFirst({ where: { section_id, subject_id, teacher_id } });
  if (!existingAssignment) {
    await prisma.sectionSubject.create({ data: { section_id, subject_id, teacher_id } });
  }
  res.status(201).json(entry);
}));
router.get("/timetable", asyncHandler(async (req,res)=>{
  const schoolId = schoolIdGetter();
  const scope = getScope()!;
  const {section_id}=req.query;

  // A teacher's timetable = every period for a section+subject they're assigned
  // to teach (SectionSubject), plus any period explicitly tagged with their id.
  // Matching only on TimetableEntry.teacher_id misses periods that were
  // scheduled before the assignment, or with a stale/blank teacher.
  let teacherFilter = {};
  if (scope.role === "teacher") {
    const assignments = await prisma.sectionSubject.findMany({
      where: { teacher_id: scope.userId! },
      select: { section_id: true, subject_id: true },
    });
    teacherFilter = {
      OR: [
        { teacher_id: scope.userId! },
        ...assignments.map((a) => ({ section_id: a.section_id, subject_id: a.subject_id })),
      ],
    };
  }

  const entries = await prisma.timetableEntry.findMany({
    where:{ school_id:schoolId, ...(section_id?{section_id:String(section_id)}:{}), ...teacherFilter },
    include: { section: { include: { class: true } }, subject: true },
    orderBy: [{ day_of_week: "asc" }, { start_time: "asc" }],
  });
  res.json(entries);
}));
router.delete("/timetable/:id", asyncHandler(async (req,res)=>{
  const { id } = req.params;
  // TimetableEntry is auto-scoped by the Prisma extension, so this 404s
  // instead of deleting if the entry belongs to a different school.
  const existing = await prisma.timetableEntry.findFirst({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Timetable entry not found" });
  await prisma.timetableEntry.delete({ where: { id } });
  res.status(204).send();
}));

// Subjects
router.get("/subjects", asyncHandler(async (req,res)=>{
  const schoolId = schoolIdGetter();
  const subjects = await prisma.subject.findMany({ where:{ school_id:schoolId }, orderBy:{ name:"asc" } });
  res.json(subjects);
}));
router.post("/subjects", asyncHandler(async (req,res)=>{
  const schoolId = schoolIdGetter();
  const { name, curriculum_subject_name } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  const subject = await prisma.subject.create({
    data: {
      school_id: schoolId,
      name,
      curriculum_subject_name: curriculum_subject_name ? String(curriculum_subject_name) : null,
    },
  });
  res.status(201).json(subject);
}));
router.patch("/subjects/:id", asyncHandler(async (req,res)=>{
  const { id } = req.params;
  const { name, curriculum_subject_name } = req.body;
  // Subject is auto-scoped to this school by the Prisma extension, so a subject
  // from another school 404s (P2025) rather than updating.
  const existing = await prisma.subject.findFirst({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Subject not found" });
  const subject = await prisma.subject.update({
    where: { id },
    data: {
      ...(name !== undefined && { name: String(name).trim() }),
      ...(curriculum_subject_name !== undefined && {
        curriculum_subject_name: curriculum_subject_name ? String(curriculum_subject_name) : null,
      }),
    },
  });
  res.json(subject);
}));

// Which sections/subjects the current teacher teaches
router.get("/my-sections", asyncHandler(async (req,res)=>{
  const scope = getScope()!;
  const assignments = await prisma.sectionSubject.findMany({
    where:{ teacher_id: scope.userId! },
    include: { section: { include: { class: true } }, subject: true },
  });
  res.json(assignments);
}));

// Board-aligned syllabus for each class the current teacher is assigned to.
// Resolution: SectionSubject -> Section.Class.grade_level + Subject name -> the
// school board's CurriculumSubject -> its units. Entries that can't resolve are
// returned with an `unresolved` reason so the teacher knows what's missing.
router.get("/my-syllabus", asyncHandler(async (req,res)=>{
  const scope = getScope()!;
  const schoolId = schoolIdGetter();

  const [school, assignments] = await Promise.all([
    prisma.school.findUnique({ where: { id: schoolId }, select: { board_id: true, board: { select: { name: true } } } }),
    prisma.sectionSubject.findMany({
      where: { teacher_id: scope.userId! },
      include: { section: { include: { class: true } }, subject: true },
    }),
  ]);

  const boardId = school?.board_id ?? null;
  const boardName = school?.board?.name ?? null;

  const base = assignments.map((a) => {
    const gradeLevel = a.section?.class?.grade_level ?? null;
    const name = a.subject?.curriculum_subject_name || a.subject?.name || "";
    return {
      section_id: a.section_id,
      section_name: a.section?.name ?? "",
      class_name: a.section?.class?.name ?? "",
      grade_level: gradeLevel,
      subject_id: a.subject_id,
      subject_name: a.subject?.name ?? "",
      resolveName: name,
    };
  });

  // One query for every distinct (grade, name) pair we actually need.
  const pairs = boardId
    ? [...new Map(
        base
          .filter((b) => b.grade_level != null && b.resolveName)
          .map((b) => [`${b.grade_level}::${b.resolveName.toLowerCase()}`, { grade: b.grade_level as number, name: b.resolveName }]),
      ).values()]
    : [];

  const curriculumSubjects = pairs.length
    ? await prisma.curriculumSubject.findMany({
        where: {
          board_id: boardId!,
          OR: pairs.map((p) => ({ grade: p.grade, name: { equals: p.name, mode: "insensitive" as const } })),
        },
        include: { units: { orderBy: { sequence: "asc" } } },
      })
    : [];

  const findCs = (grade: number, name: string) =>
    curriculumSubjects.find((cs) => cs.grade === grade && cs.name.toLowerCase() === name.toLowerCase());

  const result = base.map((b) => {
    const common = {
      section_id: b.section_id,
      section_name: b.section_name,
      class_name: b.class_name,
      subject_id: b.subject_id,
      subject_name: b.subject_name,
      grade_level: b.grade_level,
    };
    if (!boardId) return { ...common, unresolved: "Your school has no board set. Ask an admin to set it in Settings." };
    if (b.grade_level == null) return { ...common, unresolved: `"${b.class_name}" has no grade level. Ask an admin to set it in Academics.` };
    const cs = findCs(b.grade_level, b.resolveName);
    if (!cs) {
      return {
        ...common,
        unresolved: `No ${boardName ?? "board"} syllabus for "${b.resolveName}" · Grade ${b.grade_level}.`,
      };
    }
    return {
      ...common,
      board_name: boardName,
      curriculum_subject: { id: cs.id, name: cs.name, grade: cs.grade },
      units: cs.units.map((u) => ({
        id: u.id,
        sequence: u.sequence,
        title: u.title,
        description: u.description,
        term: u.term,
        suggested_periods: u.suggested_periods,
      })),
    };
  });

  // Attach this teacher's lesson-plan status to each resolved unit.
  const resolvedSectionIds = [...new Set(result.filter((r) => "units" in r).map((r) => r.section_id))];
  if (resolvedSectionIds.length) {
    const plans = await prisma.lessonPlanEntry.findMany({
      where: { teacher_id: scope.userId!, section_id: { in: resolvedSectionIds } },
      select: { id: true, section_id: true, curriculum_unit_id: true, status: true, notes: true },
    });
    const byKey = new Map(plans.map((p) => [`${p.section_id}::${p.curriculum_unit_id}`, p]));
    for (const r of result) {
      if (!("units" in r) || !r.units) continue;
      r.units = r.units.map((u: any) => {
        const plan = byKey.get(`${r.section_id}::${u.id}`);
        return { ...u, plan: plan ? { id: plan.id, status: plan.status, has_notes: !!plan.notes } : null };
      });
    }
  }

  res.json(result);
}));

// ── Lesson plans (Phase 4) ────────────────────────────────────────────────

router.get("/lesson-plans", asyncHandler(async (req,res)=>{
  const scope = getScope()!;
  const { section_id } = req.query;
  const plans = await prisma.lessonPlanEntry.findMany({
    where: { teacher_id: scope.userId!, ...(section_id ? { section_id: String(section_id) } : {}) },
    orderBy: { updated_at: "desc" },
  });
  res.json(plans);
}));

// Upsert one plan per (teacher, section, unit).
router.post("/lesson-plans", asyncHandler(async (req,res)=>{
  const scope = getScope()!;
  const schoolId = schoolIdGetter();
  const { section_id, curriculum_unit_id, title, notes, status, planned_date } = req.body ?? {};
  if (!section_id || !title) return res.status(400).json({ error: "section_id and title required" });
  const data = {
    school_id: schoolId,
    teacher_id: scope.userId!,
    section_id: String(section_id),
    curriculum_unit_id: curriculum_unit_id ? String(curriculum_unit_id) : null,
    title: String(title).trim(),
    notes: notes != null ? String(notes) : null,
    status: status && ["planned", "in_progress", "done"].includes(status) ? status : "planned",
    planned_date: planned_date ? new Date(planned_date) : null,
  };
  const update = { title: data.title, notes: data.notes, status: data.status, planned_date: data.planned_date };
  // Compound-unique upsert needs a non-null unit id; free-form plans just create.
  const plan = data.curriculum_unit_id
    ? await prisma.lessonPlanEntry.upsert({
        where: {
          teacher_id_section_id_curriculum_unit_id: {
            teacher_id: scope.userId!,
            section_id: data.section_id,
            curriculum_unit_id: data.curriculum_unit_id,
          },
        },
        create: data,
        update,
      })
    : await prisma.lessonPlanEntry.create({ data });
  res.status(201).json(plan);
}));

router.patch("/lesson-plans/:id", asyncHandler(async (req,res)=>{
  const scope = getScope()!;
  const existing = await prisma.lessonPlanEntry.findFirst({ where: { id: req.params.id, teacher_id: scope.userId! } });
  if (!existing) return res.status(404).json({ error: "Lesson plan not found" });
  const { title, notes, status, planned_date } = req.body ?? {};
  const plan = await prisma.lessonPlanEntry.update({
    where: { id: req.params.id },
    data: {
      ...(title !== undefined && { title: String(title).trim() }),
      ...(notes !== undefined && { notes: notes != null ? String(notes) : null }),
      ...(status !== undefined && ["planned", "in_progress", "done"].includes(status) && { status }),
      ...(planned_date !== undefined && { planned_date: planned_date ? new Date(planned_date) : null }),
    },
  });
  res.json(plan);
}));

router.delete("/lesson-plans/:id", asyncHandler(async (req,res)=>{
  const scope = getScope()!;
  const existing = await prisma.lessonPlanEntry.findFirst({ where: { id: req.params.id, teacher_id: scope.userId! } });
  if (!existing) return res.status(404).json({ error: "Lesson plan not found" });
  await prisma.lessonPlanEntry.delete({ where: { id: req.params.id } });
  res.status(204).send();
}));

// AI draft — not saved. Resolves the unit + subject + grade + board for context.
router.post("/lesson-plans/generate", asyncHandler(async (req,res)=>{
  const scope = getScope()!;
  const schoolId = schoolIdGetter();
  const { curriculum_unit_id, section_id, notes } = req.body ?? {};
  if (!curriculum_unit_id) return res.status(400).json({ error: "curriculum_unit_id required" });

  const unit = await prisma.curriculumUnit.findUnique({
    where: { id: String(curriculum_unit_id) },
    include: { subject: { include: { board: { select: { name: true } } } } },
  });
  if (!unit) return res.status(404).json({ error: "Unit not found" });

  let className = `Grade ${unit.subject.grade}`;
  if (section_id) {
    const section = await prisma.section.findFirst({ where: { id: String(section_id) }, include: { class: true } });
    if (section?.class?.name) className = `${section.class.name} ${section.name ?? ""}`.trim();
  }

  try {
    const markdown = await generateLessonPlan({
      board: unit.subject.board?.name ?? null,
      grade: unit.subject.grade,
      subject: unit.subject.name,
      unitTitle: unit.title,
      className,
      teacherNotes: notes ? String(notes) : null,
    });
    res.json({ markdown });
  } catch (err) {
    console.error("lesson plan generate failed:", err);
    res.status(502).json({ error: err instanceof Error ? err.message : "AI generation failed" });
  }
}));
router.post("/section-subjects", asyncHandler(async (req,res)=>{
  const schoolId = schoolIdGetter();
  const { section_id, subject_id, teacher_id } = req.body;
  if (!section_id || !subject_id || !teacher_id) return res.status(400).json({ error: "section_id, subject_id, teacher_id required" });
  const [validSectionSubject, validTeacher] = await Promise.all([
    assertSectionAndSubjectInSchool(section_id, subject_id),
    assertTeacherInSchool(teacher_id, schoolId),
  ]);
  if (!validSectionSubject || !validTeacher) {
    return res.status(400).json({ error: "section, subject or teacher does not belong to this school" });
  }
  const assignment = await prisma.sectionSubject.create({ data:{ section_id, subject_id, teacher_id } });
  res.status(201).json(assignment);
}));

// All section/subject/teacher assignments in the school (admin view), optionally filtered by teacher
router.get("/section-subjects", asyncHandler(async (req,res)=>{
  const schoolId = schoolIdGetter();
  const { teacher_id } = req.query;
  const assignments = await prisma.sectionSubject.findMany({
    where: { section: { school_id: schoolId }, ...(teacher_id ? { teacher_id: String(teacher_id) } : {}) },
    include: { section: { include: { class: true } }, subject: true },
  });
  res.json(assignments);
}));

router.delete("/section-subjects/:id", asyncHandler(async (req,res)=>{
  const schoolId = schoolIdGetter();
  const { id } = req.params;
  const existing = await prisma.sectionSubject.findFirst({ where: { id, section: { school_id: schoolId } } });
  if (!existing) return res.status(404).json({ error: "Assignment not found" });
  await prisma.sectionSubject.delete({ where: { id } });
  res.status(204).send();
}));

// Homework
router.post("/homework", upload.single("attachment"), asyncHandler(async (req,res)=>{
  const schoolId = schoolIdGetter();
  const {section_id,subject_id,title,description,due_date}=req.body;
  // file upload to R2 stub
  const attachment_url = req.file ? `https://r2.example.com/${req.file.originalname}` : null;
  const hw = await prisma.homework.create({ data:{ school_id:schoolId, section_id, subject_id, teacher_id:getScope()!.userId!, title, description, due_date: toDate(due_date), attachment_url }});
  res.status(201).json(hw);
}));
router.get("/homework", asyncHandler(async (req,res)=>{
  const schoolId = schoolIdGetter();
  const {section_id}=req.query;
  const list = await prisma.homework.findMany({ where:{ school_id:schoolId, ...(section_id?{section_id:String(section_id)}:{}) }, orderBy:{due_date:"asc"} });
  res.json(list);
}));

// Exams
router.get("/exams", asyncHandler(async (req,res)=>{
  const schoolId = schoolIdGetter();
  const exams = await prisma.exam.findMany({ where:{ school_id:schoolId }, orderBy:{ created_at:"desc" } });
  res.json(exams);
}));
router.post("/exams", asyncHandler(async (req,res)=>{
  const scope = getScope()!;
  if (!["school_admin", "super_admin"].includes(scope.role!)) {
    return res.status(403).json({ error: "Only a school admin can create exams" });
  }
  const schoolId = schoolIdGetter();
  const {name,academic_term}=req.body;
  if (!name || !academic_term) return res.status(400).json({ error: "name and academic_term required" });
  const exam = await prisma.exam.create({ data:{ school_id:schoolId, name, academic_term }});
  res.status(201).json(exam);
}));

// Marks for a given exam+subject (roster prefill)
router.get("/marks", asyncHandler(async (req,res)=>{
  const { exam_id, subject_id } = req.query;
  if (!exam_id || !subject_id) return res.status(400).json({ error: "exam_id and subject_id required" });
  // Marks has no school_id column of its own, so it can't be auto-scoped —
  // verify the exam and subject actually belong to the caller's school first.
  const [exam, subject] = await Promise.all([
    prisma.exam.findFirst({ where: { id: String(exam_id) } }),
    prisma.subject.findFirst({ where: { id: String(subject_id) } }),
  ]);
  if (!exam || !subject) return res.status(404).json({ error: "Exam or subject not found" });
  const marks = await prisma.marks.findMany({ where:{ exam_id:String(exam_id), subject_id:String(subject_id) } });
  res.json(marks);
}));

// Bulk marks
router.post("/marks/bulk", asyncHandler(async (req,res)=>{
  const {exam_id,subject_id, marks}=req.body; // marks:[{student_id, marks_obtained, max_marks}]
  const [exam, subject] = await Promise.all([
    prisma.exam.findFirst({ where: { id: exam_id } }),
    prisma.subject.findFirst({ where: { id: subject_id } }),
  ]);
  if (!exam || !subject) return res.status(404).json({ error: "Exam or subject not found" });
  const entered_by = getScope()!.userId!;
  // Validate every student in one query (Student is auto-scoped to this school),
  // then write all rows in a single batched transaction.
  const studentIds: string[] = marks.map((m: any) => m.student_id);
  const validStudents = await prisma.student.findMany({
    where: { id: { in: studentIds } },
    select: { id: true },
  });
  const validIds = new Set(validStudents.map((s) => s.id));
  const toWrite = marks.filter((m: any) => validIds.has(m.student_id));
  await prisma.$transaction(
    toWrite.map((m: any) =>
      prisma.marks.upsert({
        where: { exam_id_student_id_subject_id: { exam_id, student_id: m.student_id, subject_id } },
        update: { marks_obtained: m.marks_obtained, max_marks: m.max_marks, entered_by },
        create: { exam_id, student_id: m.student_id, subject_id, marks_obtained: m.marks_obtained, max_marks: m.max_marks, entered_by },
      })
    )
  );
  res.json({ upserted: toWrite.length });
}));

// Report card PDF generation
router.post("/report-card/generate", asyncHandler(async (req,res)=>{
  const schoolId = schoolIdGetter();
  const {student_id, exam_id}=req.body;
  const [student, exam] = await Promise.all([
    prisma.student.findFirst({ where: { id: student_id } }),
    prisma.exam.findFirst({ where: { id: exam_id } }),
  ]);
  if (!student || !exam) return res.status(404).json({ error: "Student or exam not found" });
  const school = await prisma.school.findUnique({ where:{ id:schoolId }});
  const marks = await prisma.marks.findMany({ where:{ student_id, exam_id } });
  // PDF generation stub – in real implementation use @react-pdf/renderer
  const pdfUrl = `https://r2.example.com/reportcards/${student_id}_${exam_id}.pdf`;
  res.json({ pdfUrl, schoolName: school?.name });
}));

router.post("/report-cards/bulk", asyncHandler(async (req,res)=>{
  const schoolId = schoolIdGetter();
  const {class_id, exam_id}=req.body;
  const exam = await prisma.exam.findFirst({ where: { id: exam_id } });
  if (!exam) return res.status(404).json({ error: "Exam not found" });
  const students = await prisma.student.findMany({ where:{ school_id:schoolId, section:{ class_id } }});
  const urls = [];
  for(const s of students){
    const pdfUrl = `https://r2.example.com/reportcards/${s.id}_${exam_id}.pdf`;
    urls.push({ student_id:s.id, pdfUrl });
  }
  res.json({ urls });
}));

export { router as academicsRouter };
