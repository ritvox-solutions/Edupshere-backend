import "dotenv/config";
import prisma from "../src/lib/prisma";
import * as bcrypt from "bcryptjs";

async function main() {
  const school = await prisma.school.create({
    data: {
      name: "Demo School",
      address: "12 MG Road, Demo City",
      academic_year_start: new Date("2026-04-01"),
      academic_year_end: new Date("2027-03-31"),
      language_default: "en",
      subscription_status: "trial",
    },
  });
  console.log("School:", school.id, school.name);

  const adminHash = await bcrypt.hash("Admin@123", 10);
  const admin = await prisma.profile.create({
    data: { full_name: "School Admin", email: "admin@edusphere.test", password_hash: adminHash, preferred_language: "en" },
  });
  await prisma.userRole.create({ data: { user_id: admin.id, school_id: school.id, role: "school_admin" } });
  console.log("Admin login: admin@edusphere.test / Admin@123");

  const teacherHash = await bcrypt.hash("Teacher@123", 10);
  const teacher = await prisma.profile.create({
    data: { full_name: "Priya Verma", email: "priya.verma@edusphere.test", password_hash: teacherHash, preferred_language: "en" },
  });
  await prisma.userRole.create({ data: { user_id: teacher.id, school_id: school.id, role: "teacher" } });
  console.log("Teacher login: priya.verma@edusphere.test / Teacher@123");

  const cls = await prisma.class.create({ data: { school_id: school.id, name: "Grade 5", display_order: 1 } });
  const section = await prisma.section.create({ data: { school_id: school.id, class_id: cls.id, name: "A" } });
  const subject = await prisma.subject.create({ data: { school_id: school.id, name: "Mathematics" } });
  await prisma.sectionSubject.create({ data: { section_id: section.id, subject_id: subject.id, teacher_id: teacher.id } });

  for (let day = 1; day <= 5; day++) {
    await prisma.timetableEntry.create({
      data: {
        school_id: school.id,
        section_id: section.id,
        subject_id: subject.id,
        teacher_id: teacher.id,
        day_of_week: day,
        start_time: "09:00",
        end_time: "09:45",
      },
    });
  }
  console.log("Timetable: Mon-Fri 09:00-09:45, Grade 5-A, Mathematics");

  const parentHash = await bcrypt.hash("Parent@123", 10);
  const parent = await prisma.profile.create({
    data: { full_name: "Rahul Gupta", email: "rahul.gupta@edusphere.test", phone: "9876543210", password_hash: parentHash, preferred_language: "en" },
  });
  await prisma.userRole.create({ data: { user_id: parent.id, school_id: school.id, role: "parent" } });

  const student = await prisma.student.create({
    data: { school_id: school.id, full_name: "Aarav Gupta", section_id: section.id, roll_number: "1", status: "active" },
  });
  await prisma.studentGuardian.create({
    data: { student_id: student.id, guardian_profile_id: parent.id, relationship: "father", is_primary_contact: true },
  });
  console.log("Parent login: rahul.gupta@edusphere.test / Parent@123 (child: Aarav Gupta)");

  await prisma.feeStructure.create({
    data: { school_id: school.id, class_id: cls.id, fee_head: "Tuition Fee", amount: 45000, academic_year: "2026-2027", installment_options: 1 },
  });
  console.log("Fee structure: Tuition Fee ₹45000 for Grade 5");

  console.log("\nSeed complete.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
