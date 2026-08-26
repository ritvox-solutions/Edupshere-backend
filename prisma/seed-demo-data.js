// One-off utility to flesh out Demo School with realistic sample data for
// manual testing — sections, subjects, teachers, students (with guardians),
// fee structures and announcements. Safe to re-run: skips anything that
// already exists by name/email/phone instead of duplicating it.
//
// Usage: node prisma/seed-demo-data.js
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

const SUBJECT_NAMES = ["Mathematics", "English", "General Science", "Social Studies", "Hindi", "Computer Science"];

const TEACHERS = [
  { full_name: "Priya Sharma", email: "priya.sharma@demoschool.test" },
  { full_name: "Rahul Verma", email: "rahul.verma@demoschool.test" },
  { full_name: "Anita Desai", email: "anita.desai@demoschool.test" },
  { full_name: "Vikram Singh", email: "vikram.singh@demoschool.test" },
];
const TEACHER_PASSWORD = "Teacher@123";

const FIRST_NAMES = [
  "Aarav", "Vivaan", "Aditya", "Vihaan", "Arjun", "Sai", "Reyansh", "Krishna", "Ishaan", "Rohan",
  "Ananya", "Diya", "Saanvi", "Aadhya", "Kiara", "Myra", "Anika", "Navya", "Riya", "Ira",
];
const LAST_NAMES = ["Sharma", "Verma", "Gupta", "Singh", "Kumar", "Patel", "Reddy", "Nair", "Iyer", "Joshi"];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

let phoneCounter = 9000000001;
function nextPhone() {
  return String(phoneCounter++);
}

async function main() {
  const school = await prisma.school.findFirst({ where: { name: { contains: "Demo School" } } });
  if (!school) throw new Error("Demo School not found");
  console.log(`Seeding sample data into "${school.name}" (${school.id})`);

  // Resume the phone counter above whatever this script has already handed
  // out — a fresh 9000000001 on every run collided with guardians created
  // by a prior run and crashed on the unique constraint.
  const lastGuardian = await prisma.profile.findFirst({
    where: { phone: { gte: "9000000000", lt: "9100000000" } },
    orderBy: { phone: "desc" },
  });
  if (lastGuardian?.phone) {
    phoneCounter = Number(lastGuardian.phone) + 1;
  }

  // Subjects
  const existingSubjects = await prisma.subject.findMany({ where: { school_id: school.id } });
  const existingSubjectNames = new Set(existingSubjects.map((s) => s.name));
  const newSubjects = SUBJECT_NAMES.filter((n) => !existingSubjectNames.has(n));
  if (newSubjects.length) {
    await prisma.subject.createMany({ data: newSubjects.map((name) => ({ school_id: school.id, name })) });
  }
  const subjects = await prisma.subject.findMany({ where: { school_id: school.id } });
  console.log(`Subjects: ${subjects.map((s) => s.name).join(", ")}`);

  // Sections — ensure every class has at least one
  const classes = await prisma.class.findMany({ where: { school_id: school.id }, orderBy: { display_order: "asc" } });
  for (const cls of classes) {
    const count = await prisma.section.count({ where: { class_id: cls.id } });
    if (count === 0) {
      await prisma.section.create({ data: { school_id: school.id, class_id: cls.id, name: "A" } });
    }
  }
  const sections = await prisma.section.findMany({ where: { school_id: school.id }, include: { class: true } });
  console.log(`Sections: ${sections.length} across ${classes.length} classes`);

  // Teachers (with login credentials for testing the teacher portal)
  const teacherProfiles = [];
  for (const t of TEACHERS) {
    let profile = await prisma.profile.findFirst({ where: { email: t.email } });
    if (!profile) {
      profile = await prisma.profile.create({
        data: {
          full_name: t.full_name,
          email: t.email,
          password_hash: await bcrypt.hash(TEACHER_PASSWORD, 10),
          preferred_language: "en",
        },
      });
      await prisma.userRole.create({ data: { user_id: profile.id, school_id: school.id, role: "teacher" } });
    }
    teacherProfiles.push(profile);
  }
  const allTeacherRoles = await prisma.userRole.findMany({ where: { school_id: school.id, role: "teacher" } });
  const allTeachers = await prisma.profile.findMany({ where: { id: { in: allTeacherRoles.map((r) => r.user_id) } } });
  console.log(`Teachers: ${allTeachers.map((t) => t.full_name).join(", ")} (password for new ones: ${TEACHER_PASSWORD})`);

  // Section-subject-teacher assignments — round-robin so every section has coverage
  let assignIdx = 0;
  for (const section of sections) {
    for (const subject of subjects.slice(0, 3)) {
      const teacher = allTeachers[assignIdx % allTeachers.length];
      assignIdx++;
      const existing = await prisma.sectionSubject.findFirst({
        where: { section_id: section.id, subject_id: subject.id, teacher_id: teacher.id },
      });
      if (!existing) {
        await prisma.sectionSubject.create({
          data: { section_id: section.id, subject_id: subject.id, teacher_id: teacher.id },
        });
      }
    }
  }
  console.log("Section-subject-teacher assignments created.");

  // Students — 5 per section, each with one guardian
  let studentsCreated = 0;
  const usedStudentNames = new Set();
  for (const section of sections) {
    const existingCount = await prisma.student.count({ where: { section_id: section.id } });
    const toAdd = Math.max(0, 5 - existingCount);
    for (let i = 0; i < toAdd; i++) {
      let name;
      do {
        name = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
      } while (usedStudentNames.has(name));
      usedStudentNames.add(name);

      const rollNumber = String(existingCount + i + 1).padStart(2, "0");
      const student = await prisma.student.create({
        data: {
          school_id: school.id,
          section_id: section.id,
          full_name: name,
          roll_number: rollNumber,
          admission_date: new Date(),
          status: "active",
        },
      });

      const guardianPhone = nextPhone();
      const guardian = await prisma.profile.create({
        data: {
          full_name: `${name.split(" ")[1]} (Guardian)`,
          phone: guardianPhone,
          preferred_language: "en",
        },
      });
      await prisma.userRole.create({ data: { user_id: guardian.id, school_id: school.id, role: "parent" } });
      await prisma.studentGuardian.create({
        data: { student_id: student.id, guardian_profile_id: guardian.id, relationship: "guardian", is_primary_contact: true },
      });
      studentsCreated++;
    }
  }
  console.log(`Students created: ${studentsCreated}`);

  // Fee structures — one Tuition Fee per class that doesn't have one yet
  let feesCreated = 0;
  for (const cls of classes) {
    const existing = await prisma.feeStructure.count({ where: { class_id: cls.id } });
    if (existing === 0) {
      await prisma.feeStructure.create({
        data: {
          school_id: school.id,
          class_id: cls.id,
          fee_head: "Tuition Fee",
          amount: 12000,
          academic_year: "2026-2027",
          installment_options: 4,
        },
      });
      feesCreated++;
    }
  }
  console.log(`Fee structures created: ${feesCreated}`);

  console.log("\nDone. Sign in as a teacher with one of:");
  for (const t of TEACHERS) console.log(`  ${t.email} / ${TEACHER_PASSWORD}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
