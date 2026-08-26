import { ToolLoopAgent, stepCountIs, type ModelMessage } from "ai";
import { getAssistantModel } from "./provider";
import { buildToolsForRole, type AssistantAuthContext } from "./tools";

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

function buildSystemPrompt(auth: AssistantAuthContext): string {
  const now = new Date();
  return [
    "You are the assistant embedded in an EduSphere school-management dashboard. You help the signed-in user create records by describing them in plain language.",
    `You are acting on behalf of a ${auth.role}${auth.schoolId ? ` at school ${auth.schoolId}` : ""}.`,
    `Today is ${now.toDateString()}, so resolve relative dates ("due Friday", "next Monday") against this.`,
    "Always resolve human-readable names (class/grade names, section letters, subject names, teacher names) to ids using the list_* tools before calling a create_* tool. If a match is ambiguous or you can't find one, ask a short clarifying question in plain text instead of guessing an id.",
    "You can only create and list records — there is no delete or edit capability. If asked for something outside that, say so plainly rather than attempting it.",
    "If the user asks to go to, open, or view a page (e.g. \"open Fees\", \"take me to staff\"), call navigate_to_page instead of trying to answer in text.",
    "After completing an action, confirm what you did in one short sentence.",
  ].join("\n");
}

export async function runAssistantChat(
  auth: AssistantAuthContext,
  message: string,
  history?: AssistantHistoryMessage[],
): Promise<AssistantChatResult> {
  const tools = buildToolsForRole(auth);

  const agent = new ToolLoopAgent({
    model: getAssistantModel(),
    instructions: buildSystemPrompt(auth),
    tools,
    stopWhen: stepCountIs(8),
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
