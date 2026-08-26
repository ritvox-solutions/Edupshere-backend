// Generates a full Mon-Sat weekly timetable for every section of Demo School:
// eight 40-minute periods per day within a 09:00-16:00 school day, lunch
// fixed at 12:40-13:30 (09:00-12:40 isn't an exact multiple of 40 minutes,
// so there's a 20-min gap right before lunch and a 30-min gap after the
// last period, before the 16:00 close). Subjects rotate round-robin so each
// gets an even share across the week. Fills in any missing section-subject-
// teacher assignment (round-robin over the school's teachers) before
// scheduling, then wipes and rewrites the timetable in one batch insert.
//
// Usage: node prisma/generate-timetable.js
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const DAYS = [1, 2, 3, 4, 5, 6]; // Mon-Sat
const PERIODS = [
  ["09:00", "09:40"],
  ["09:40", "10:20"],
  ["10:20", "11:00"],
  ["11:00", "11:40"],
  ["11:40", "12:20"],
  // 12:20-12:40 gap, then lunch: 12:40-13:30
  ["13:30", "14:10"],
  ["14:10", "14:50"],
  ["14:50", "15:30"],
  // 15:30-16:00 free before the school day closes
];

async function main() {
  const school = await prisma.school.findFirst({ where: { name: { contains: "Demo School" } } });
  if (!school) throw new Error("Demo School not found");

  const sections = await prisma.section.findMany({ where: { school_id: school.id }, include: { class: true } });
  const subjects = await prisma.subject.findMany({ where: { school_id: school.id }, orderBy: { name: "asc" } });
  const teacherRoles = await prisma.userRole.findMany({ where: { school_id: school.id, role: "teacher" } });
  const teacherIds = teacherRoles.map((r) => r.user_id);

  if (!subjects.length || !teacherIds.length) throw new Error("Need at least one subject and one teacher first");

  const deleted = await prisma.timetableEntry.deleteMany({ where: { school_id: school.id } });
  console.log(`Cleared ${deleted.count} existing timetable entries.`);

  let teacherRR = 0;
  const entries = [];

  for (const section of sections) {
    const existingAssignments = await prisma.sectionSubject.findMany({ where: { section_id: section.id } });
    const teacherFor = {};
    for (const a of existingAssignments) {
      if (!teacherFor[a.subject_id]) teacherFor[a.subject_id] = a.teacher_id;
    }
    for (const subject of subjects) {
      if (!teacherFor[subject.id]) {
        const teacher_id = teacherIds[teacherRR % teacherIds.length];
        teacherRR++;
        teacherFor[subject.id] = teacher_id;
        await prisma.sectionSubject.create({ data: { section_id: section.id, subject_id: subject.id, teacher_id } });
      }
    }

    DAYS.forEach((day, dIdx) => {
      PERIODS.forEach(([start, end], pIdx) => {
        const subject = subjects[(dIdx + pIdx) % subjects.length];
        entries.push({
          school_id: school.id,
          section_id: section.id,
          subject_id: subject.id,
          teacher_id: teacherFor[subject.id],
          day_of_week: day,
          start_time: start,
          end_time: end,
        });
      });
    });
  }

  await prisma.timetableEntry.createMany({ data: entries });
  console.log(`Created ${entries.length} timetable entries across ${sections.length} sections (${DAYS.length} days x ${PERIODS.length} periods).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
