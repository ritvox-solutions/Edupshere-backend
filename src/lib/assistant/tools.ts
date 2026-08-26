import { tool, type Tool } from "ai";
import { z } from "zod";
import * as bcrypt from "bcryptjs";
import prisma from "../prisma";
import { runWithScope, type Scope } from "../scope";
import { toDate } from "../dates";
import { generateTempPassword } from "../password";

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
  settings: "/admin/settings",
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
  homework: "/homework",
  marks: "/marks",
  announcements: "/announcements",
  attendance: "/attendance",
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

export function buildToolsForRole(auth: AssistantAuthContext): Record<string, Tool> {
  if (auth.role === "super_admin") return superAdminTools(auth);
  if (auth.role === "school_admin") return schoolAdminTools(auth);
  if (auth.role === "teacher") return teacherTools(auth);
  return {};
}
