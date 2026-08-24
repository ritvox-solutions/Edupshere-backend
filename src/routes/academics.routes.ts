import { Router } from "express";
import multer from "multer";
import prisma from "../lib/prisma";
import { getScope } from "../lib/scope";
import { authMiddleware } from "../middleware/auth";
import { toDate } from "../lib/dates";

const router = Router();
router.use(authMiddleware);
const upload = multer({ storage: multer.memoryStorage() });

function schoolIdGetter(){ return getScope()!.schoolId!; }

router.post("/timetable", async (req,res)=>{
  const schoolId = schoolIdGetter();
  const {section_id,subject_id,teacher_id,day_of_week,start_time,end_time}=req.body;
  const entry = await prisma.timetableEntry.create({ data:{ school_id:schoolId, section_id, subject_id, teacher_id, day_of_week,start_time,end_time }});
  // Scheduling a class implies the teacher is assigned to it — keep the assignment table in sync
  // so attendance/homework authorization (which checks SectionSubject) doesn't diverge from the schedule.
  const existingAssignment = await prisma.sectionSubject.findFirst({ where: { section_id, subject_id, teacher_id } });
  if (!existingAssignment) {
    await prisma.sectionSubject.create({ data: { section_id, subject_id, teacher_id } });
  }
  res.status(201).json(entry);
});
router.get("/timetable", async (req,res)=>{
  const schoolId = schoolIdGetter();
  const scope = getScope()!;
  const {section_id}=req.query;
  const teacherFilter = scope.role === "teacher" ? { teacher_id: scope.userId! } : {};
  const entries = await prisma.timetableEntry.findMany({
    where:{ school_id:schoolId, ...(section_id?{section_id:String(section_id)}:{}), ...teacherFilter },
    include: { section: { include: { class: true } }, subject: true },
    orderBy: [{ day_of_week: "asc" }, { start_time: "asc" }],
  });
  res.json(entries);
});

// Subjects
router.get("/subjects", async (req,res)=>{
  const schoolId = schoolIdGetter();
  const subjects = await prisma.subject.findMany({ where:{ school_id:schoolId }, orderBy:{ name:"asc" } });
  res.json(subjects);
});
router.post("/subjects", async (req,res)=>{
  const schoolId = schoolIdGetter();
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  const subject = await prisma.subject.create({ data:{ school_id:schoolId, name } });
  res.status(201).json(subject);
});

// Which sections/subjects the current teacher teaches
router.get("/my-sections", async (req,res)=>{
  const scope = getScope()!;
  const assignments = await prisma.sectionSubject.findMany({
    where:{ teacher_id: scope.userId! },
    include: { section: { include: { class: true } }, subject: true },
  });
  res.json(assignments);
});
router.post("/section-subjects", async (req,res)=>{
  const { section_id, subject_id, teacher_id } = req.body;
  if (!section_id || !subject_id || !teacher_id) return res.status(400).json({ error: "section_id, subject_id, teacher_id required" });
  const assignment = await prisma.sectionSubject.create({ data:{ section_id, subject_id, teacher_id } });
  res.status(201).json(assignment);
});

// All section/subject/teacher assignments in the school (admin view), optionally filtered by teacher
router.get("/section-subjects", async (req,res)=>{
  const schoolId = schoolIdGetter();
  const { teacher_id } = req.query;
  const assignments = await prisma.sectionSubject.findMany({
    where: { section: { school_id: schoolId }, ...(teacher_id ? { teacher_id: String(teacher_id) } : {}) },
    include: { section: { include: { class: true } }, subject: true },
  });
  res.json(assignments);
});

router.delete("/section-subjects/:id", async (req,res)=>{
  const schoolId = schoolIdGetter();
  const { id } = req.params;
  const existing = await prisma.sectionSubject.findFirst({ where: { id, section: { school_id: schoolId } } });
  if (!existing) return res.status(404).json({ error: "Assignment not found" });
  await prisma.sectionSubject.delete({ where: { id } });
  res.status(204).send();
});

// Homework
router.post("/homework", upload.single("attachment"), async (req,res)=>{
  const schoolId = schoolIdGetter();
  const {section_id,subject_id,title,description,due_date}=req.body;
  // file upload to R2 stub
  const attachment_url = req.file ? `https://r2.example.com/${req.file.originalname}` : null;
  const hw = await prisma.homework.create({ data:{ school_id:schoolId, section_id, subject_id, teacher_id:getScope()!.userId!, title, description, due_date: toDate(due_date), attachment_url }});
  res.status(201).json(hw);
});
router.get("/homework", async (req,res)=>{
  const schoolId = schoolIdGetter();
  const {section_id}=req.query;
  const list = await prisma.homework.findMany({ where:{ school_id:schoolId, ...(section_id?{section_id:String(section_id)}:{}) }, orderBy:{due_date:"asc"} });
  res.json(list);
});

// Exams
router.get("/exams", async (req,res)=>{
  const schoolId = schoolIdGetter();
  const exams = await prisma.exam.findMany({ where:{ school_id:schoolId }, orderBy:{ created_at:"desc" } });
  res.json(exams);
});
router.post("/exams", async (req,res)=>{
  const scope = getScope()!;
  if (!["school_admin", "super_admin"].includes(scope.role!)) {
    return res.status(403).json({ error: "Only a school admin can create exams" });
  }
  const schoolId = schoolIdGetter();
  const {name,academic_term}=req.body;
  if (!name || !academic_term) return res.status(400).json({ error: "name and academic_term required" });
  const exam = await prisma.exam.create({ data:{ school_id:schoolId, name, academic_term }});
  res.status(201).json(exam);
});

// Marks for a given exam+subject (roster prefill)
router.get("/marks", async (req,res)=>{
  const { exam_id, subject_id } = req.query;
  if (!exam_id || !subject_id) return res.status(400).json({ error: "exam_id and subject_id required" });
  const marks = await prisma.marks.findMany({ where:{ exam_id:String(exam_id), subject_id:String(subject_id) } });
  res.json(marks);
});

// Bulk marks
router.post("/marks/bulk", async (req,res)=>{
  const schoolId = schoolIdGetter();
  const {exam_id,subject_id, marks}=req.body; // marks:[{student_id, marks_obtained, max_marks}]
  const entered_by = getScope()!.userId!;
  const upserted = [];
  for(const m of marks){
    const record = await prisma.marks.upsert({
      where:{ exam_id_student_id_subject_id:{ exam_id, student_id:m.student_id, subject_id } },
      update:{ marks_obtained: m.marks_obtained, max_marks:m.max_marks, entered_by },
      create:{ exam_id, student_id:m.student_id, subject_id, marks_obtained:m.marks_obtained, max_marks:m.max_marks, entered_by }
    });
    upserted.push(record);
  }
  res.json({ upserted: upserted.length });
});

// Report card PDF generation
router.post("/report-card/generate", async (req,res)=>{
  const schoolId = schoolIdGetter();
  const {student_id, exam_id}=req.body;
  const school = await prisma.school.findUnique({ where:{ id:schoolId }});
  const student = await prisma.student.findUnique({ where:{ id:student_id }});
  const marks = await prisma.marks.findMany({ where:{ student_id, exam_id } });
  // PDF generation stub – in real implementation use @react-pdf/renderer
  const pdfUrl = `https://r2.example.com/reportcards/${student_id}_${exam_id}.pdf`;
  res.json({ pdfUrl, schoolName: school?.name });
});

router.post("/report-cards/bulk", async (req,res)=>{
  const schoolId = schoolIdGetter();
  const {class_id, exam_id}=req.body;
  const students = await prisma.student.findMany({ where:{ school_id:schoolId, section:{ class_id } }});
  const urls = [];
  for(const s of students){
    const pdfUrl = `https://r2.example.com/reportcards/${s.id}_${exam_id}.pdf`;
    urls.push({ student_id:s.id, pdfUrl });
  }
  res.json({ urls });
});

export { router as academicsRouter };
