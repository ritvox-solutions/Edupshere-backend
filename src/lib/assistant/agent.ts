import type { ModelMessage } from "ai";
import { getAssistantModel } from "./provider";
import { buildToolsForRole, type AssistantAuthContext } from "./tools";
import nativeImport from "../nativeImport";

export interface AssistantAction {
  tool: string;
  input: unknown;
  success: boolean;
  summary: string;
  path?: string;
}

export interface AssistantChatResult {
  reply: string;
  actions: AssistantAction[];
}

export interface AssistantHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

// The server clock runs in UTC (Vercel's function runtime), but schools using
// this app are in India — using the server's local time/date directly would
// put the assistant up to a day behind during early IST hours (12:00-5:30 AM
// IST is still the previous day in UTC), and previously gave it no time-of-day
// at all. Format explicitly in the app's timezone instead of relying on the
// runtime's local timezone.
function currentDateTime(): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: process.env.APP_TIMEZONE || "Asia/Kolkata",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date());
}

function buildSystemPrompt(auth: AssistantAuthContext): string {
  return [
    "You are the assistant embedded in an EduSphere school-management dashboard. You answer questions about this school's data and help the signed-in user create records by describing them in plain language.",
    `You are acting on behalf of a ${auth.role}${auth.schoolId ? ` at school ${auth.schoolId}` : ""}.`,
    "Every tool is automatically restricted to this user's own school, so you can only ever see or change data for their school — treat that as guaranteed and never caveat it.",
    "When the user asks a question about the school (how many students/teachers/classes, attendance stats, fee structures, timetable, exams, announcements, a specific student, etc.), call the relevant get_* / list_* tool and answer with the real data. Never say you don't have access to the information or that you can't count something — the tools exist for exactly this. get_school_overview gives school-wide totals; list_students (with an optional class_id/section_id) gives a roster and its count.",
    `Right now it is ${currentDateTime()}, so resolve relative dates ("due Friday", "next Monday") and times against this.`,
    "Always resolve human-readable names (class/grade names, section letters, subject names, teacher names) to ids using the list_* tools before calling a create_* tool. If a match is ambiguous or you can't find one, ask a short clarifying question in plain text instead of guessing an id.",
    "You can read (get/list) and create records — there is no delete or edit capability. If asked to delete or edit, say so plainly rather than attempting it.",
    "If the user asks to go to, open, or view a page (e.g. \"open Fees\", \"take me to staff\"), call navigate_to_page instead of trying to answer in text.",
    "After completing an action, confirm what you did in one short sentence.",
  ].join("\n");
}

export async function runAssistantChat(
  auth: AssistantAuthContext,
  message: string,
  history?: AssistantHistoryMessage[],
): Promise<AssistantChatResult> {
  // "ai" ships ESM-only (no "require" export condition) — see nativeImport.ts
  // for why this needs require.resolve() + a hidden dynamic import rather
  // than a plain import()/require().
  const [{ ToolLoopAgent, stepCountIs }, tools, model] = await Promise.all([
    nativeImport(require.resolve("ai")) as Promise<typeof import("ai")>,
    buildToolsForRole(auth),
    getAssistantModel(),
  ]);

  // gpt-oss (and most reasoning models) burn most of their latency on reasoning
  // tokens; "low" effort roughly halves round-trip time and is plenty for this
  // resolve-names-then-call-a-tool workload. Keyed by the provider name set in
  // ./provider.ts. Override or disable with ASSISTANT_REASONING_EFFORT.
  const reasoningEffort = process.env.ASSISTANT_REASONING_EFFORT ?? "low";
  const agent = new ToolLoopAgent({
    model,
    instructions: buildSystemPrompt(auth),
    tools,
    stopWhen: stepCountIs(6),
    ...(reasoningEffort && reasoningEffort !== "off"
      ? { providerOptions: { assistant: { reasoningEffort } } }
      : {}),
  });

  const priorMessages: ModelMessage[] = (history ?? []).map((m) => ({ role: m.role, content: m.content }));
  const result = await agent.generate({ prompt: [...priorMessages, { role: "user", content: message }] });

  // A malformed/unparsable tool call (invalid: true) never actually ran, and
  // a well-formed call with no matching result didn't complete either — both
  // must report as failed rather than falling through to a false "Done.".
  const actions: AssistantAction[] = result.toolCalls
    .filter((call) => !(call as { invalid?: boolean }).invalid)
    .map((call) => {
      const matchingResult = result.toolResults.find((r) => r.toolCallId === call.toolCallId);
      if (!matchingResult) {
        return { tool: call.toolName, input: call.input, success: false, summary: "That action didn't complete." };
      }
      const output = matchingResult.output as { isError?: boolean; summary?: string; path?: string } | undefined;
      return {
        tool: call.toolName,
        input: call.input,
        success: !output?.isError,
        summary: output?.summary ?? (output?.isError ? "That action failed." : "Done."),
        ...(output?.path ? { path: output.path } : {}),
      };
    });

  return { reply: result.text || "Done.", actions };
}
