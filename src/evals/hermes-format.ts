/**
 * "Prompted" tool calling in the Hermes format, for models served without native tool support
 * (on OpenRouter every Nous Hermes model reports `tools: false`). Instead of the API's `tools`
 * parameter, the tool signatures go into the system prompt inside `<tools>` tags, and the model
 * answers with `<tool_call>{"name": …, "arguments": {…}}</tool_call>` blocks in plain text,
 * which this module parses. Tool results go back as `<tool_response>` blocks.
 *
 * This is the format Hermes 2 Pro / 3 / 4 were fine-tuned on (Nous Research's function-calling
 * prompt), so it measures those models on their home turf; it also lets any model be run both
 * ways, which separates "can the model pick the right tool" from "does the provider's native
 * tool-calling layer help".
 */

export interface PromptedTool {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ParsedCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ParsedTurn {
  calls: ParsedCall[];
  /** One entry per `<tool_call>` block that was not valid `{"name", "arguments"}` JSON. */
  formatErrors: string[];
  /** The text with tool-call and reasoning blocks removed — the answer when there are no calls. */
  text: string;
}

export function hermesSystemPrompt(tools: PromptedTool[], preamble: string): string {
  const signatures = tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  return (
    `${preamble}\n\n` +
    'You are a function calling AI model. You are provided with function signatures within ' +
    '<tools></tools> XML tags. You may call one or more functions to assist with the user ' +
    "query. Don't make assumptions about what values to plug into functions. Here are the " +
    `available tools: <tools> ${JSON.stringify(signatures)} </tools>\n` +
    'For each function call return a json object with function name and arguments within ' +
    '<tool_call></tool_call> XML tags as follows:\n' +
    '<tool_call>\n{"name": <function-name>, "arguments": <args-dict>}\n</tool_call>\n' +
    'Function results come back inside <tool_response></tool_response> tags. When you have ' +
    'what you need, answer the user directly without any <tool_call> tags.'
  );
}

/** Strip a ```json fence some models wrap the JSON in. */
function unfence(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function looksLikeBareCall(text: string): boolean {
  const body = unfence(text.replace(/^[^{]*/, ''));
  try {
    const parsed = JSON.parse(body) as { name?: unknown; arguments?: unknown };
    return typeof parsed.name === 'string' && 'arguments' in parsed;
  } catch {
    return /^\s*\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"/.test(body);
  }
}

export function parseHermesTurn(content: string): ParsedTurn {
  const calls: ParsedCall[] = [];
  const formatErrors: string[] = [];
  // An unclosed final <tool_call> (output cut off) is still an attempted call.
  const pattern = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g;
  for (const match of content.matchAll(pattern)) {
    const raw = unfence(match[1]);
    try {
      const parsed = JSON.parse(raw) as { name?: unknown; arguments?: unknown };
      let args = parsed.arguments ?? {};
      // Some models double-encode arguments as a JSON string.
      if (typeof args === 'string') {
        args = JSON.parse(args);
      }
      if (typeof parsed.name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('expected {"name": string, "arguments": object}');
      }
      calls.push({ name: parsed.name, args: args as Record<string, unknown> });
    } catch (error) {
      formatErrors.push(`${error instanceof Error ? error.message : String(error)}: ${raw.slice(0, 120)}`);
    }
  }
  const text = content
    .replace(pattern, '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim();
  // A call written without its tags is still a call, not an answer: seen live, a model emitted
  // a bare {"name": "booking_url", …} as its last turn, which would otherwise end the run.
  if (!calls.length && !formatErrors.length && looksLikeBareCall(text)) {
    formatErrors.push(`tool call without <tool_call> tags: ${text.slice(0, 120)}`);
  }
  return { calls, formatErrors, text };
}

export function hermesToolResponse(name: string, content: string): string {
  return `<tool_response>\n${JSON.stringify({ name, content })}\n</tool_response>`;
}
