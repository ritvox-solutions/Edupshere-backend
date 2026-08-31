import type { Tool } from "ai";
import { z } from "zod";
import * as bcrypt from "bcryptjs";
import prisma from "../prisma";
import { runWithScope, type Scope } from "../scope";
import { toDate } from "../dates";
import { generateTempPassword } from "../password";
import nativeImport from "../nativeImport";

// Primitives only — never close over the JWT, req, or res. The Agent SDK's
// tool loop invokes these handlers outside the request's own call stack, so
// AsyncLocalStorage-based scope (see ../scope.ts) cannot be trusted to reach
// them ambiently; every handler re-enters it explicitly with values captured
// here at request time. This is the actual multi-tenant security boundary.
export interface AssistantAuthContext {
  schoolId: string | null;
  role: string;
  userId: string;
}

// "ai" ships ESM-only (no "require" export condition) — see nativeImport.ts
// for why this needs require.resolve() + a hidden dynamic import rather than
// a plain import()/require(). Loading it once and caching the binding here
// lets every tool() call below stay exactly as written, instead of threading
// it through every builder function and all ~25 call sites.
let tool: (typeof import("ai"))["tool"];
async function ensureAiLoaded() {
  if (!tool) ({ tool } = (await nativeImport(require.resolve("ai"))) as typeof import("ai"));
}

// Tool execute() results feed straight back to the model as the next turn's
// context, so a thrown error here must become a plain { isError, summary }
// value rather than surfacing as an AI SDK tool-error part — this keeps every
// outcome uniform for agent.ts to report back to the frontend.
async function scoped<T>(auth: AssistantAuthContext, fn: () => Promise<T>): Promise<T | { isError: true; summary: string }> {
  const scope: Scope = { schoolId: auth.schoolId, role: auth.role, userId: auth.userId };
  try {
    return await runWithScope(scope, fn);
  } catch (err) {
    return { isError: true, summary: err instanceof Error ? err.message : "Something went wrong." };
  }
}

// Navigation is a client-side action — this tool does no DB work at all, it
// just resolves a page name to a path from a fixed per-role allowlist (so the
// model can only ever send the frontend to a real page that role can see) and
// hands that path back; the assistant widget is the one that actually calls
// the router.
function buildNavigateTool(pages: Record<string, string>): Tool {
  const pageNames = Object.keys(pages) as [string, ...string[]];
  return tool({
    description: `Navigate the user's dashboard to a different page. Valid pages: ${pageNames.join(", ")}.`,
    inputSchema: z.object({ page: z.enum(pageNames) }),
    execute: async ({ page }) => ({ path: pages[page], summary: `Opening ${page.replace(/-/g, " ")}.` }),
  });
}

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

// Shared by the school_admin and teacher attendance-summary tools — mirrors
// the aggregation in attendance.routes.ts GET /summary, plus student names
// (the route only needs ids since the frontend already has the roster; the
// assistant needs names inline since it can't cross-reference a separate list).
async function attendanceSummary(where: Record<string, unknown>) {
  const records = await prisma.attendanceRecord.findMany({ where: where as any, select: { student_id: true, status: true } });
  if (!records.length) return [];
  const totals: Record<string, { present: number; total: number }> = {};
  for (const r of records) {
    if (!totals[r.student_id]) totals[r.student_id] = { present: 0, total: 0 };
    totals[r.student_id].total++;
    if (r.status === "present") totals[r.student_id].present++;
  }
  const studentIds = Object.keys(totals);
  const students = await prisma.student.findMany({ where: { id: { in: studentIds } }, select: { id: true, full_name: true, roll_number: true } });
  return studentIds.map((id) => {
    const student = students.find((s) => s.id === id);
    const t = totals[id];
    return {
      student_id: id,
      full_name: student?.full_name ?? "Unknown",
      roll_number: student?.roll_number,
      attendance_pct: Math.round((t.present / t.total) * 100),
      days_recorded: t.total,
    };
  });
}

function dateRangeFilter(start_date?: string, end_date?: string) {
  return start_date && end_date ? { date: { gte: new Date(start_date), lte: new Date(end_date) } } : {};
}

const SCHOOL_ADMIN_PAGES: Record<string, string> = {
  dashboard: "/admin",
  students: "/admin/students",
  staff: "/admin/staff",
  academics: "/admin/academics",
  timetable: "/admin/timetable",
  fees: "/admin/fees",
  announcements: "/admin/announcements",
  "attendance-summary": "/admin/attendance-summary",
  "bulk-report-cards": "/admin/bulk-report-cards",
  profile: "/admin/profile",
};

function schoolAdminTools(auth: AssistantAuthContext): Record<string, Tool> {
  const schoolId = auth.schoolId!;

  return {
    navigate_to_page: buildNavigateTool(SCHOOL_ADMIN_PAGES),

    list_classes: tool({
      description: "List every class/grade in the school, with id, name and display order.",
      inputSchema: z.object({}),
      execute: async () => scoped(auth, async () => {
        const classes = await prisma.class.findMany({ where: { school_id: schoolId }, orderBy: { display_order: "asc" } });
        return classes.map((c) => ({ id: c.id, name: c.name, display_order: c.display_order }));
      }),
    }),

    list_sections: tool({
      description: "List sections, optionally filtered by class_id. Use this to resolve a section name (e.g. '5B') to an id.",
      inputSchema: z.object({ class_id: z.string().optional() }),
      execute: async ({ class_id }) => scoped(auth, async () => {
        const sections = await prisma.section.findMany({
          where: { school_id: schoolId, ...(class_id ? { class_id } : {}) },
          include: { class: true },
        });
        return sections.map((s) => ({ id: s.id, name: s.name, class_id: s.class_id, class_name: s.class?.name }));
      }),
    }),

    list_subjects: tool({
      description: "List every subject in the school's shared subject catalog.",
      inputSchema: z.object({}),
      execute: async () => scoped(auth, async () => {
        const subjects = await prisma.subject.findMany({ where: { school_id: schoolId }, orderBy: { name: "asc" } });
        return subjects.map((s) => ({ id: s.id, name: s.name }));
      }),
    }),

    list_teachers: tool({
      description: "List every teacher in the school with id and name, so you can resolve a teacher's name to an id.",
      inputSchema: z.object({}),
      execute: async () => scoped(auth, async () => {
        const roles = await prisma.userRole.findMany({
          where: { school_id: schoolId, role: "teacher" },
          include: { user: { select: { id: true, full_name: true, email: true } } },
        });
        return roles.map((r) => r.user);
      }),
    }),

    get_attendance_summary: tool({
      description: "Get each student's attendance percentage, optionally filtered by class and date range. Use this to answer any question about attendance stats. class_id must come from list_classes; omit it to cover the whole school.",
      inputSchema: z.object({ class_id: z.string().optional(), start_date: z.string().optional(), end_date: z.string().optional() }),
      execute: async ({ class_id, start_date, end_date }) => scoped(auth, async () => {
        // AttendanceRecord only has a section_id scalar (no Prisma relation
        // to Section), so a class filter has to resolve section ids first.
        let sectionFilter = {};
        if (class_id) {
          const sections = await prisma.section.findMany({ where: { class_id }, select: { id: true } });
          sectionFilter = { section_id: { in: sections.map((s) => s.id) } };
        }
        const summary = await attendanceSummary({
          school_id: schoolId,
          ...sectionFilter,
          ...dateRangeFilter(start_date, end_date),
        });
        return summary.length ? summary : { summary: "No attendance records found for that filter." };
      }),
    }),

    get_school_overview: tool({
      description:
        "Headline numbers for the whole school: total students, teachers, classes, sections, subjects, and today's attendance. Call this for any 'how many ...' question about the school overall.",
      inputSchema: z.object({}),
      execute: async () => scoped(auth, async () => {
        const today = new Date(new Date().toISOString().slice(0, 10));
        const [students, teachers, classes, sections, subjects, byStatus] = await Promise.all([
          prisma.student.count({ where: { school_id: schoolId } }),
          prisma.userRole.count({ where: { school_id: schoolId, role: "teacher" } }),
          prisma.class.count({ where: { school_id: schoolId } }),
          prisma.section.count({ where: { school_id: schoolId } }),
          prisma.subject.count({ where: { school_id: schoolId } }),
          prisma.attendanceRecord.groupBy({ by: ["status"], where: { school_id: schoolId, date: today }, _count: { _all: true } }),
        ]);
        const marked = byStatus.reduce((sum, r) => sum + r._count._all, 0);
        const present = byStatus.find((r) => r.status === "present")?._count._all ?? 0;
        return {
          total_students: students,
          total_teachers: teachers,
          total_classes: classes,
          total_sections: sections,
          total_subjects: subjects,
          todays_attendance_marked: marked,
          todays_attendance_pct: marked ? Math.round((present / marked) * 100) : null,
        };
      }),
    }),

    list_students: tool({
      description:
        "List students with name, roll number, status, section and class. Optionally filter by class_id (from list_classes) or section_id (from list_sections). Returns the total count and the list. Use this to answer 'how many students' for a class/section or to find a specific student.",
      inputSchema: z.object({ class_id: z.string().optional(), section_id: z.string().optional() }),
      execute: async ({ class_id, section_id }) => scoped(auth, async () => {
        const students = await prisma.student.findMany({
          where: {
            school_id: schoolId,
            ...(section_id ? { section_id } : {}),
            ...(class_id ? { section: { class_id } } : {}),
          },
          include: { section: { include: { class: true } } },
          orderBy: { full_name: "asc" },
        });
        return {
          count: students.length,
          students: students.map((s) => ({
            id: s.id,
            full_name: s.full_name,
            roll_number: s.roll_number,
            status: s.status,
            section_id: s.section_id,
            section_name: s.section?.name,
            class_name: s.section?.class?.name,
          })),
        };
      }),
    }),

    list_fee_structures: tool({
      description: "List fee structures in the school (fee head, amount, class, academic year, due date). Optionally filter by class_id.",
      inputSchema: z.object({ class_id: z.string().optional() }),
      execute: async ({ class_id }) => scoped(auth, async () => {
        const fees = await prisma.feeStructure.findMany({
          where: { school_id: schoolId, ...(class_id ? { class_id } : {}) },
          include: { class: true },
          orderBy: { created_at: "desc" },
        });
        return fees.map((f) => ({
          id: f.id,
          fee_head: f.fee_head,
          amount: Number(f.amount),
          academic_year: f.academic_year,
          due_date: f.due_date,
          installment_options: f.installment_options,
          class_name: f.class?.name,
        }));
      }),
    }),

    list_exams: tool({
      description: "List every exam/assessment cycle in the school with id, name and academic term.",
      inputSchema: z.object({}),
      execute: async () => scoped(auth, async () => {
        const exams = await prisma.exam.findMany({ where: { school_id: schoolId }, orderBy: { created_at: "desc" } });
        return exams.map((e) => ({ id: e.id, name: e.name, academic_term: e.academic_term }));
      }),
    }),

    list_timetable: tool({
      description: "List scheduled class periods (day, time, section, subject, teacher). Optionally filter by section_id from list_sections.",
      inputSchema: z.object({ section_id: z.string().optional() }),
      execute: async ({ section_id }) => scoped(auth, async () => {
        const entries = await prisma.timetableEntry.findMany({
          where: { school_id: schoolId, ...(section_id ? { section_id } : {}) },
          include: { section: { include: { class: true } }, subject: true, teacher: { select: { full_name: true } } },
          orderBy: [{ day_of_week: "asc" }, { start_time: "asc" }],
        });
        return entries.map((e) => ({
          id: e.id,
          day_of_week: e.day_of_week,
          start_time: e.start_time,
          end_time: e.end_time,
          section_name: e.section?.name,
          class_name: e.section?.class?.name,
          subject_name: e.subject?.name,
          teacher_name: e.teacher?.full_name,
        }));
      }),
    }),

    list_announcements: tool({
      description: "List recent announcements in the school, newest first.",
      inputSchema: z.object({}),
      execute: async () => scoped(auth, async () => {
        const list = await prisma.announcement.findMany({
          where: { school_id: schoolId },
          include: { author: { select: { full_name: true } } },
          orderBy: { created_at: "desc" },
          take: 50,
        });
        return list.map((a) => ({
          id: a.id,
          title: a.title,
          body: a.body,
          audience_type: a.audience_type,
          priority: a.priority,
          author_name: a.author?.full_name,
          created_at: a.created_at,
        }));
      }),
    }),

    create_class: tool({
      description: "Create a new class/grade in the school.",
      inputSchema: z.object({ name: z.string(), display_order: z.number().optional() }),
      execute: async ({ name, display_order }) => scoped(auth, async () => {
        // Some models occasionally double-emit an identical tool call in one
        // turn — check-before-create keeps that from silently duplicating data.
        const existing = await prisma.class.findFirst({ where: { school_id: schoolId, name } });
        if (existing) return { id: existing.id, summary: `Class "${existing.name}" already exists.` };
        const cls = await prisma.class.create({ data: { school_id: schoolId, name, display_order: display_order ?? 0 } });
        return { id: cls.id, summary: `Created class "${cls.name}".` };
      }),
    }),

    create_section: tool({
      description: "Create a new section under an existing class. class_id must come from list_classes.",
      inputSchema: z.object({ class_id: z.string(), name: z.string(), class_teacher_id: z.string().optional() }),
      execute: async ({ class_id, name, class_teacher_id }) => scoped(auth, async () => {
        const cls = await prisma.class.findFirst({ where: { id: class_id } });
        if (!cls) return { isError: true, summary: "class_id does not belong to this school." };
        const existing = await prisma.section.findFirst({ where: { class_id, name } });
        if (existing) return { id: existing.id, summary: `Section "${existing.name}" already exists under ${cls.name}.` };
        const sec = await prisma.section.create({ data: { school_id: schoolId, class_id, name, class_teacher_id } });
        return { id: sec.id, summary: `Created section "${sec.name}" under ${cls.name}.` };
      }),
    }),

    create_subject: tool({
      description: "Add a new subject to the school's shared subject catalog.",
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => scoped(auth, async () => {
        const existing = await prisma.subject.findFirst({ where: { school_id: schoolId, name } });
        if (existing) return { id: existing.id, summary: `Subject "${existing.name}" already exists.` };
        const subject = await prisma.subject.create({ data: { school_id: schoolId, name } });
        return { id: subject.id, summary: `Created subject "${subject.name}".` };
      }),
    }),

    create_teacher: tool({
      description: "Create a new teacher account.",
      inputSchema: z.object({ full_name: z.string(), email: z.string().email().optional(), phone: z.string().optional() }),
      execute: async ({ full_name, email, phone }) => scoped(auth, async () => {
        const tempPassword = generateTempPassword();
        const password_hash = await bcrypt.hash(tempPassword, 10);
        const profile = await prisma.profile.create({ data: { full_name, email, phone, password_hash, preferred_language: "en" } });
        await prisma.userRole.create({ data: { user_id: profile.id, school_id: schoolId, role: "teacher" } });
        return { id: profile.id, summary: `Created teacher "${full_name}" (temporary password: ${tempPassword}).` };
      }),
    }),

    create_student: tool({
      description: "Enroll a new student into a section. section_id must come from list_sections.",
      inputSchema: z.object({
        full_name: z.string(),
        section_id: z.string(),
        roll_number: z.string(),
        dob: z.string().optional(),
        admission_date: z.string().optional(),
        guardian_phones: z.array(z.string()).optional(),
      }),
      execute: async ({ full_name, section_id, roll_number, dob, admission_date, guardian_phones }) => scoped(auth, async () => {
        const section = await prisma.section.findFirst({ where: { id: section_id } });
        if (!section) return { isError: true, summary: "section_id does not belong to this school." };
        const student = await prisma.student.create({
          data: { school_id: schoolId, full_name, dob: toDate(dob), section_id, roll_number, admission_date: toDate(admission_date), status: "active" },
        });
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
        return { id: student.id, summary: `Enrolled "${full_name}" (roll no. ${roll_number}).` };
      }),
    }),

    create_timetable_entry: tool({
      description: "Schedule a class period. section_id/subject_id/teacher_id must come from list_sections/list_subjects/list_teachers. day_of_week: 1=Mon..6=Sat. Times as HH:MM 24h.",
      inputSchema: z.object({
        section_id: z.string(),
        subject_id: z.string(),
        teacher_id: z.string(),
        day_of_week: z.number().min(1).max(6),
        start_time: z.string(),
        end_time: z.string(),
      }),
      execute: async ({ section_id, subject_id, teacher_id, day_of_week, start_time, end_time }) => scoped(auth, async () => {
        const [validSectionSubject, validTeacher] = await Promise.all([
          assertSectionAndSubjectInSchool(section_id, subject_id),
          assertTeacherInSchool(teacher_id, schoolId),
        ]);
        if (!validSectionSubject || !validTeacher) {
          return { isError: true, summary: "section, subject or teacher does not belong to this school." };
        }
        const existingEntry = await prisma.timetableEntry.findFirst({ where: { section_id, day_of_week, start_time } });
        if (existingEntry) return { isError: true, summary: "That section already has a period scheduled at that time." };
        const entry = await prisma.timetableEntry.create({ data: { school_id: schoolId, section_id, subject_id, teacher_id, day_of_week, start_time, end_time } });
        const existingAssignment = await prisma.sectionSubject.findFirst({ where: { section_id, subject_id, teacher_id } });
        if (!existingAssignment) {
          await prisma.sectionSubject.create({ data: { section_id, subject_id, teacher_id } });
        }
        return { id: entry.id, summary: `Scheduled a period on day ${day_of_week} from ${start_time} to ${end_time}.` };
      }),
    }),

    assign_section_subject: tool({
      description: "Assign a teacher to teach a subject in a section, without scheduling a specific period.",
      inputSchema: z.object({ section_id: z.string(), subject_id: z.string(), teacher_id: z.string() }),
      execute: async ({ section_id, subject_id, teacher_id }) => scoped(auth, async () => {
        const [validSectionSubject, validTeacher] = await Promise.all([
          assertSectionAndSubjectInSchool(section_id, subject_id),
          assertTeacherInSchool(teacher_id, schoolId),
        ]);
        if (!validSectionSubject || !validTeacher) {
          return { isError: true, summary: "section, subject or teacher does not belong to this school." };
        }
        const existing = await prisma.sectionSubject.findFirst({ where: { section_id, subject_id, teacher_id } });
        if (existing) return { id: existing.id, summary: "That teacher is already assigned to that section/subject." };
        const assignment = await prisma.sectionSubject.create({ data: { section_id, subject_id, teacher_id } });
        return { id: assignment.id, summary: "Assigned the teacher to that section/subject." };
      }),
    }),

    create_exam: tool({
      description: "Create a new exam/assessment cycle for the school.",
      inputSchema: z.object({ name: z.string(), academic_term: z.string() }),
      execute: async ({ name, academic_term }) => scoped(auth, async () => {
        const exam = await prisma.exam.create({ data: { school_id: schoolId, name, academic_term } });
        return { id: exam.id, summary: `Created exam "${exam.name}".` };
      }),
    }),

    create_fee_structure: tool({
      description: "Create a fee structure for a class. class_id must come from list_classes.",
      inputSchema: z.object({
        class_id: z.string(),
        fee_head: z.string(),
        amount: z.number(),
        due_date: z.string().optional(),
        academic_year: z.string(),
        installment_options: z.number().optional(),
      }),
      execute: async ({ class_id, fee_head, amount, due_date, academic_year, installment_options }) => scoped(auth, async () => {
        const cls = await prisma.class.findFirst({ where: { id: class_id } });
        if (!cls) return { isError: true, summary: "class_id does not belong to this school." };
        const fs = await prisma.feeStructure.create({
          data: { school_id: schoolId, class_id, fee_head, amount, due_date: toDate(due_date), academic_year, installment_options: installment_options ?? 1 },
        });
        return { id: fs.id, summary: `Created fee structure "${fee_head}" (${amount}) for ${cls.name}.` };
      }),
    }),

    create_announcement: tool({
      description: "Post an announcement to the school, a class, or a section.",
      inputSchema: z.object({
        title: z.string(),
        body: z.string(),
        audience_type: z.enum(["school", "class", "section"]),
        audience_id: z.string().optional(),
        priority: z.enum(["low", "medium", "high"]).optional(),
      }),
      execute: async ({ title, body, audience_type, audience_id, priority }) => scoped(auth, async () => {
        const announcement = await prisma.announcement.create({
          data: { school_id: schoolId, author_id: auth.userId, audience_type, audience_id: audience_id ?? null, title, body, priority: priority ?? "medium" },
        });
        return { id: announcement.id, summary: `Posted announcement "${announcement.title}".` };
      }),
    }),
  };
}

const TEACHER_PAGES: Record<string, string> = {
  home: "/teacher",
  timetable: "/teacher/timetable",
  syllabus: "/teacher/syllabus",
  homework: "/homework",
  marks: "/marks",
  announcements: "/announcements",
  attendance: "/attendance",
  profile: "/teacher/profile",
};

function teacherTools(auth: AssistantAuthContext): Record<string, Tool> {
  return {
    navigate_to_page: buildNavigateTool(TEACHER_PAGES),

    list_my_sections: tool({
      description: "List the sections and subjects this teacher teaches, with ids, so you can resolve names like '5B Mathematics' before creating homework.",
      inputSchema: z.object({}),
      execute: async () => scoped(auth, async () => {
        const assignments = await prisma.sectionSubject.findMany({
          where: { teacher_id: auth.userId },
          include: { section: { include: { class: true } }, subject: true },
        });
        return assignments.map((a) => ({
          section_id: a.section_id,
          section_name: a.section?.name,
          class_name: a.section?.class?.name,
          subject_id: a.subject_id,
          subject_name: a.subject?.name,
        }));
      }),
    }),

    get_section_attendance_summary: tool({
      description: "Get each student's attendance percentage for a section this teacher teaches, optionally within a date range. Use this to answer any question about attendance stats. section_id must come from list_my_sections.",
      inputSchema: z.object({ section_id: z.string(), start_date: z.string().optional(), end_date: z.string().optional() }),
      execute: async ({ section_id, start_date, end_date }) => scoped(auth, async () => {
        const [assignment, section] = await Promise.all([
          prisma.sectionSubject.findFirst({ where: { section_id, teacher_id: auth.userId } }),
          prisma.section.findFirst({ where: { id: section_id } }),
        ]);
        if (!assignment && section?.class_teacher_id !== auth.userId) {
          return { isError: true, summary: "You don't teach that section." };
        }
        const summary = await attendanceSummary({ section_id, ...dateRangeFilter(start_date, end_date) });
        return summary.length ? summary : { summary: "No attendance records found for that section/range." };
      }),
    }),

    list_section_students: tool({
      description:
        "List the students in a section this teacher teaches (name, roll number, status). section_id must come from list_my_sections. Returns the count and the list — use it to answer 'how many students in 5B'.",
      inputSchema: z.object({ section_id: z.string() }),
      execute: async ({ section_id }) => scoped(auth, async () => {
        const [assignment, section] = await Promise.all([
          prisma.sectionSubject.findFirst({ where: { section_id, teacher_id: auth.userId } }),
          prisma.section.findFirst({ where: { id: section_id } }),
        ]);
        if (!assignment && section?.class_teacher_id !== auth.userId) {
          return { isError: true, summary: "You don't teach that section." };
        }
        const students = await prisma.student.findMany({
          where: { section_id },
          orderBy: { roll_number: "asc" },
          select: { id: true, full_name: true, roll_number: true, status: true },
        });
        return { count: students.length, students };
      }),
    }),

    list_my_homework: tool({
      description: "List homework this teacher has posted, newest due date first. Optionally filter by section_id.",
      inputSchema: z.object({ section_id: z.string().optional() }),
      execute: async ({ section_id }) => scoped(auth, async () => {
        const list = await prisma.homework.findMany({
          where: { teacher_id: auth.userId, ...(section_id ? { section_id } : {}) },
          orderBy: { due_date: "desc" },
          take: 50,
        });
        return list.map((h) => ({
          id: h.id,
          title: h.title,
          description: h.description,
          due_date: h.due_date,
          section_id: h.section_id,
          subject_id: h.subject_id,
        }));
      }),
    }),

    list_announcements: tool({
      description: "List recent announcements in this teacher's school, newest first.",
      inputSchema: z.object({}),
      execute: async () => scoped(auth, async () => {
        const list = await prisma.announcement.findMany({
          where: { school_id: auth.schoolId! },
          orderBy: { created_at: "desc" },
          take: 50,
        });
        return list.map((a) => ({
          id: a.id,
          title: a.title,
          body: a.body,
          audience_type: a.audience_type,
          priority: a.priority,
          created_at: a.created_at,
        }));
      }),
    }),

    create_homework: tool({
      description: "Post homework for a section/subject this teacher teaches. section_id and subject_id must come from list_my_sections.",
      inputSchema: z.object({
        section_id: z.string(),
        subject_id: z.string(),
        title: z.string(),
        description: z.string(),
        due_date: z.string().optional(),
      }),
      execute: async ({ section_id, subject_id, title, description, due_date }) => scoped(auth, async () => {
        const assignment = await prisma.sectionSubject.findFirst({ where: { section_id, subject_id, teacher_id: auth.userId } });
        if (!assignment) return { isError: true, summary: "You don't teach that subject in that section." };
        const hw = await prisma.homework.create({
          data: { school_id: auth.schoolId!, section_id, subject_id, teacher_id: auth.userId, title, description, due_date: toDate(due_date), attachment_url: null },
        });
        return { id: hw.id, summary: `Posted homework "${hw.title}".` };
      }),
    }),

    create_announcement: tool({
      description: "Post an announcement to a class or section.",
      inputSchema: z.object({
        title: z.string(),
        body: z.string(),
        audience_type: z.enum(["class", "section"]),
        audience_id: z.string().optional(),
        priority: z.enum(["low", "medium", "high"]).optional(),
      }),
      execute: async ({ title, body, audience_type, audience_id, priority }) => scoped(auth, async () => {
        const announcement = await prisma.announcement.create({
          data: { school_id: auth.schoolId!, author_id: auth.userId, audience_type, audience_id: audience_id ?? null, title, body, priority: priority ?? "medium" },
        });
        return { id: announcement.id, summary: `Posted announcement "${announcement.title}".` };
      }),
    }),
  };
}

const SUPER_ADMIN_PAGES: Record<string, string> = {
  schools: "/superadmin",
  "new-school": "/superadmin/schools/new",
};

function superAdminTools(auth: AssistantAuthContext): Record<string, Tool> {
  return {
    navigate_to_page: buildNavigateTool(SUPER_ADMIN_PAGES),

    list_schools: tool({
      description: "List every school on the platform with id, name and student count.",
      inputSchema: z.object({}),
      execute: async () => scoped(auth, async () => {
        const schools = await prisma.school.findMany({
          where: { name: { not: "__platform__" } },
          orderBy: { created_at: "desc" },
          include: { _count: { select: { students: true } } },
        });
        return schools.map((s) => ({ id: s.id, name: s.name, address: s.address, studentCount: s._count.students }));
      }),
    }),

    create_school: tool({
      description: "Onboard a brand-new school and its first admin login. Auto-seeds Class 1-10.",
      inputSchema: z.object({
        name: z.string(),
        address: z.string(),
        admin_full_name: z.string(),
        admin_email: z.string().email(),
      }),
      execute: async ({ name, address, admin_full_name, admin_email }) => scoped(auth, async () => {
        const existingAdmin = await prisma.profile.findFirst({ where: { email: admin_email } });
        if (existingAdmin) return { isError: true, summary: "A user with this admin email already exists." };

        const now = new Date();
        const yearStart = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
        const tempPassword = generateTempPassword();
        const passwordHash = await bcrypt.hash(tempPassword, 10);

        const { school, adminProfile } = await prisma.$transaction(async (tx) => {
          const school = await tx.school.create({
            data: {
              name,
              address,
              academic_year_start: new Date(Date.UTC(yearStart, 3, 1)),
              academic_year_end: new Date(Date.UTC(yearStart + 1, 2, 31)),
              language_default: "en",
              subscription_status: "trial",
            },
          });
          const adminProfile = await tx.profile.create({
            data: { full_name: admin_full_name, email: admin_email, password_hash: passwordHash, preferred_language: "en" },
          });
          await tx.userRole.create({ data: { user_id: adminProfile.id, school_id: school.id, role: "school_admin" } });
          await tx.class.createMany({
            data: Array.from({ length: 10 }, (_, i) => ({ school_id: school.id, name: `Class ${i + 1}`, display_order: i })),
          });
          return { school, adminProfile };
        });

        return {
          id: school.id,
          summary: `Created school "${school.name}" with admin login ${adminProfile.email} (temporary password: ${tempPassword}).`,
        };
      }),
    }),

    add_school_admin: tool({
      description: "Add another admin login to an existing school. school_id must come from list_schools.",
      inputSchema: z.object({ school_id: z.string(), full_name: z.string(), email: z.string().email() }),
      execute: async ({ school_id, full_name, email }) => scoped(auth, async () => {
        const school = await prisma.school.findUnique({ where: { id: school_id } });
        if (!school) return { isError: true, summary: "School not found." };
        const existing = await prisma.profile.findFirst({ where: { email } });
        if (existing) return { isError: true, summary: "A user with this email already exists." };
        const tempPassword = generateTempPassword();
        const password_hash = await bcrypt.hash(tempPassword, 10);
        const profile = await prisma.profile.create({ data: { full_name, email, password_hash, preferred_language: "en" } });
        await prisma.userRole.create({ data: { user_id: profile.id, school_id, role: "school_admin" } });
        return { id: profile.id, summary: `Added ${full_name} (${email}) as an admin of "${school.name}" (temporary password: ${tempPassword}).` };
      }),
    }),
  };
}

export async function buildToolsForRole(auth: AssistantAuthContext): Promise<Record<string, Tool>> {
  await ensureAiLoaded();
  if (auth.role === "super_admin") return superAdminTools(auth);
  if (auth.role === "school_admin") return schoolAdminTools(auth);
  if (auth.role === "teacher") return teacherTools(auth);
  return {};
}
