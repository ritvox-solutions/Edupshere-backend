import { PrismaClient } from "@prisma/client";

// Seeds the Phase-1 curriculum pilot: the three initial boards, plus one fully
// entered subject (CBSE Class 8 Mathematics) to prove the school -> board ->
// class -> subject -> syllabus wiring end to end.
//
// Run: npx tsx prisma/seed-curriculum.ts   (idempotent)
//
// Content note: the unit list below is the NCERT rationalised (2023) Class 8
// Maths chapters. Real syllabi for other boards/grades/subjects are data-entry
// work — see 08_Lesson_Planner_Plan.md. Verify against the current board
// document before relying on it in production.

const prisma = new PrismaClient();

const BOARDS = [
  { code: "cbse", name: "CBSE", region: null as string | null },
  { code: "icse", name: "ICSE (CISCE)", region: null as string | null },
  { code: "ka-kseeb", name: "Karnataka State Board (KSEEB)", region: "Karnataka" },
];

// Best-effort NCERT chapter lists. These change with each NCERT revision —
// treat as a starting point and correct via the super-admin Curriculum editor.
// { grade, subject: [unit titles...] }
const CBSE_CONTENT: Array<{ grade: number; subject: string; units: string[] }> = [
  {
    grade: 8,
    subject: "Mathematics",
    units: [
      "Rational Numbers",
      "Linear Equations in One Variable",
      "Understanding Quadrilaterals",
      "Data Handling",
      "Squares and Square Roots",
      "Cubes and Cube Roots",
      "Comparing Quantities",
      "Algebraic Expressions and Identities",
      "Mensuration",
      "Exponents and Powers",
      "Direct and Inverse Proportions",
      "Factorisation",
      "Introduction to Graphs",
    ],
  },
  {
    grade: 1,
    subject: "Mathematics",
    units: [
      "Shapes and Space",
      "Numbers from One to Nine",
      "Addition",
      "Subtraction",
      "Numbers from Ten to Twenty",
      "Time",
      "Measurement",
      "Numbers from Twenty-one to Fifty",
      "Data Handling",
      "Patterns",
      "Numbers",
      "Money",
      "How Many",
    ],
  },
  {
    grade: 1,
    subject: "English",
    units: [
      "A Happy Child / Three Little Pigs",
      "After a Bath / The Bubble, the Straw and the Shoe",
      "One Little Kitten / Lalu and Peelu",
      "Once I Saw a Little Bird / Mittu and the Yellow Mango",
      "Merry-Go-Round / Circle",
      "If I Were an Apple / Our Tree",
      "A Kite / Sundari",
      "A Little Turtle / The Tiger and the Mosquito",
      "Clouds / Anandi's Rainbow",
      "Flying-Man / The Tailor and his Friend",
    ],
  },
  {
    grade: 1,
    subject: "Hindi",
    units: [
      "झूला",
      "आम की कहानी",
      "आम की टोकरी",
      "पत्ते ही पत्ते",
      "पकौड़ी",
      "छुक-छुक गाड़ी",
      "रसोईघर",
      "चूहो! म्याऊँ सो रही है",
      "बंदर और गिलहरी",
      "पगड़ी",
      "पतंग",
      "गेंद-बल्ला",
      "बंदर गया खेत में भाग",
      "एक बुढ़िया",
      "मैं भी",
      "लालू और पीलू",
      "चकई के चकदुम",
      "छोटी का कमाल",
      "चार चने",
    ],
  },
  {
    grade: 4,
    subject: "Mathematics",
    units: [
      "Building with Bricks",
      "Long and Short",
      "A Trip to Bhopal",
      "Tick-Tick-Tick",
      "The Way The World Looks",
      "The Junk Seller",
      "Jugs and Mugs",
      "Carts and Wheels",
      "Halves and Quarters",
      "Play with Patterns",
      "Tables and Shares",
      "How Heavy? How Light?",
      "Fields and Fences",
      "Smart Charts",
    ],
  },
  {
    grade: 4,
    subject: "English",
    units: [
      "Wake Up! / Neha's Alarm Clock",
      "Noses / The Little Fir Tree",
      "Run! / Nasruddin's Aim",
      "Why? / Alice in Wonderland",
      "Don't be Afraid of the Dark / Helen Keller",
      "Hiawatha / The Scholar's Mother Tongue",
      "A Watering Rhyme / The Giving Tree",
      "Books / Going to Buy a Book",
      "The Naughty Boy / Pinocchio",
    ],
  },
  {
    grade: 4,
    subject: "EVS",
    units: [
      "Going to School",
      "Ear to Ear",
      "A Day with Nandu",
      "The Story of Amrita",
      "Anita and the Honeybees",
      "Omana's Journey",
      "From the Window",
      "Reaching Grandmother's House",
      "Changing Families",
      "Hu Tu Tu, Hu Tu Tu",
      "The Valley of Flowers",
      "Changing Times",
      "A River's Tale",
      "Basva's Farm",
      "From Market to Home",
      "A Busy Month",
      "Nandita in Mumbai",
      "Too Much Water, Too Little Water",
      "Abdul in the Garden",
      "Eating Together",
      "Food and Fun",
      "The World in my Home",
      "Pochampalli",
      "Home and Abroad",
      "Spicy Riddles",
      "Defence Officer: Wahida",
      "Chuskit Goes to School",
    ],
  },
  // Computer Science — CBSE has no fixed primary syllabus; this is a common
  // publisher-aligned progression. Adjust per your school in the editor.
  { grade: 1, subject: "Computer Science", units: [
    "Introduction to Computers", "Parts of a Computer", "Uses of Computers",
    "Do's and Don'ts with a Computer", "Starting and Shutting Down",
    "Using the Mouse", "Using the Keyboard", "Drawing with Tux Paint",
  ] },
  { grade: 2, subject: "Computer Science", units: [
    "Computer — A Smart Machine", "Main Parts of a Computer", "Input and Output Devices",
    "The Keyboard Keys", "Working with the Mouse", "Introduction to Windows Desktop",
    "Painting with MS Paint", "Fun Learning Games",
  ] },
  { grade: 3, subject: "Computer Science", units: [
    "Computer Fundamentals", "Types of Computers", "Input, Output and Storage Devices",
    "The Windows Desktop", "MS Paint Tools", "Typing with WordPad",
    "Files and Folders", "Staying Safe Online",
  ] },
  { grade: 4, subject: "Computer Science", units: [
    "Evolution of Computers", "Computer Memory and Storage", "Operating System Basics",
    "Advanced MS Paint", "Introduction to MS Word", "Formatting Text in MS Word",
    "Introduction to the Internet", "Sending and Receiving Email",
  ] },
  { grade: 5, subject: "Computer Science", units: [
    "Generations and Languages of Computers", "Number System Basics",
    "MS Word — Tables and Pictures", "Introduction to MS PowerPoint",
    "Browsing the World Wide Web", "Block Programming with Scratch",
    "Algorithms and Flowcharts", "Cyber Safety and Netiquette",
  ] },
  { grade: 6, subject: "Computer Science", units: [
    "Computer Systems Overview", "Number Systems (Binary and Decimal)",
    "MS Word — Advanced Features", "MS Excel — Basics", "Programming with Scratch",
    "Introduction to HTML", "Digital Citizenship", "Cyber Threats and Safety",
  ] },
  { grade: 7, subject: "Computer Science", units: [
    "Computer Networks and the Internet", "MS Excel — Formulas and Charts",
    "MS PowerPoint — Animations and Transitions", "Introduction to Python",
    "Web Pages with HTML", "Algorithms and Flowcharts", "Cyber Ethics and IPR",
  ] },
  { grade: 8, subject: "Computer Science", units: [
    "Networking and the Internet", "Spreadsheets — Advanced", "Database Concepts",
    "Python Programming — Basics", "HTML and CSS", "Introduction to Artificial Intelligence",
    "Digital Footprint and Online Safety", "Ethical Use of Technology",
  ] },
  {
    grade: 4,
    subject: "Hindi",
    units: [
      "मन के भोले-भाले बादल",
      "जैसा सवाल वैसा जवाब",
      "किरमिच की गेंद",
      "पापा जब बच्चे थे",
      "दोस्त की पोशाक",
      "नाव बनाओ नाव बनाओ",
      "दान का हिसाब",
      "कौन?",
      "स्वतंत्रता की ओर",
      "थप्प रोटी थप्प दाल",
      "पढ़क्कू की सूझ",
      "सुनीता की पहिया कुर्सी",
      "हुदहुद",
      "मुफ़्त ही मुफ़्त",
    ],
  },
];

async function main() {
  for (const b of BOARDS) {
    await prisma.curriculumBoard.upsert({
      where: { code: b.code },
      update: { name: b.name, region: b.region },
      create: b,
    });
  }
  const cbse = await prisma.curriculumBoard.findUniqueOrThrow({ where: { code: "cbse" } });
  console.log(`Boards ready: ${BOARDS.map((b) => b.name).join(", ")}`);

  for (const { grade, subject, units } of CBSE_CONTENT) {
    const cs = await prisma.curriculumSubject.upsert({
      where: { board_id_grade_name: { board_id: cbse.id, grade, name: subject } },
      update: {},
      create: { board_id: cbse.id, grade, name: subject },
    });
    // Replace units so re-runs stay clean.
    await prisma.curriculumUnit.deleteMany({ where: { curriculum_subject_id: cs.id } });
    await prisma.curriculumUnit.createMany({
      data: units.map((title, i) => ({ curriculum_subject_id: cs.id, sequence: i + 1, title })),
    });
    console.log(`Seeded CBSE - Class ${grade} - ${subject} (${units.length} units)`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
