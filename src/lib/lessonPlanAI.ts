// One-shot lesson-plan generation via the same OpenAI-compatible endpoint the
// assistant uses (ASSISTANT_BASE_URL / ASSISTANT_API_KEY / ASSISTANT_MODEL).
// A plain fetch — no AI SDK needed for a single completion.

export interface LessonPlanContext {
  board: string | null;
  grade: number;
  subject: string;
  unitTitle: string;
  className: string;
  teacherNotes?: string | null;
}

export async function generateLessonPlan(ctx: LessonPlanContext): Promise<string> {
  const baseURL = process.env.ASSISTANT_BASE_URL;
  const apiKey = process.env.ASSISTANT_API_KEY;
  const model = process.env.ASSISTANT_MODEL;
  if (!baseURL || !apiKey || !model) {
    throw new Error("AI is not configured (ASSISTANT_BASE_URL / ASSISTANT_API_KEY / ASSISTANT_MODEL).");
  }

  const system =
    "You are an experienced Indian school teacher writing a practical, concise lesson plan. " +
    "Output GitHub-flavoured Markdown only, no preamble or sign-off.";

  const user = [
    "Create a lesson plan for:",
    `- Board: ${ctx.board ?? "general"}`,
    `- Class: ${ctx.className} (Grade ${ctx.grade})`,
    `- Subject: ${ctx.subject}`,
    `- Unit / chapter: "${ctx.unitTitle}"`,
    ctx.teacherNotes ? `- Teacher's notes to incorporate: ${ctx.teacherNotes}` : "",
    "",
    "Use these `##` sections in order: Learning Objectives (3-4 bullets), Key Concepts, " +
      "Suggested Activities (with rough timing), Materials Needed, Assessment / Check for Understanding, Homework. " +
      "Use bullet lists, not Markdown tables (this is read on a phone). " +
      "Keep it around 250 words and realistic for a classroom with limited resources.",
  ]
    .filter(Boolean)
    .join("\n");

  const payload = JSON.stringify({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: 900,
    temperature: 0.4,
    reasoning_effort: "low",
  });

  // The inference host can hiccup (transient DNS / connection reset). Retry the
  // network layer once before giving up.
  let res: Response | undefined;
  let lastNetErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(`${baseURL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: payload,
        signal: AbortSignal.timeout(60_000),
      });
      break;
    } catch (err) {
      lastNetErr = err;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 800));
    }
  }
  if (!res) {
    const reason = lastNetErr instanceof Error && lastNetErr.name === "TimeoutError" ? "timed out" : "couldn't be reached";
    throw new Error(`The AI service ${reason} — check your connection and try again.`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`AI request failed (${res.status})${body ? `: ${body.slice(0, 200)}` : ""}`);
  }

  const data: any = await res.json();
  const msg = data?.choices?.[0]?.message;
  const text = String(msg?.content || msg?.reasoning_content || "").trim();
  if (!text) throw new Error("The AI returned an empty response — try again.");
  return text;
}
