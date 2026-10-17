/**
 * Agent eval runner: puts a real LLM (any OpenRouter model — Claude, GPT, Hermes, …) in front of
 * a running MCP endpoint, lets it work each case with the server's own tools and instructions,
 * and scores the trace with the deterministic checks in `scoring.ts`.
 *
 *   npm run eval -- --mcp doctolib --model <openrouter-model-id> [--repeat 3] [--case id]
 *   npm run eval -- --mcp doctolib --dry-run      # no LLM: checks the cases against tools/list
 *   npm run eval -- --mcp doctolib --model <id> --tool-mode prompted
 *
 * `--tool-mode native` (default) passes tools through the API's `tools` parameter;
 * `prompted` puts them in the system prompt in the Hermes `<tool_call>` format and parses the
 * calls out of plain text (see `hermes-format.ts`) — the way to evaluate models served without
 * native tool calling, and a second axis to compare any model on.
 *
 * Needs the host running (`npm run dev`) and OPENROUTER_API_KEY in `.env`. Results go to
 * `eval-results/<mcp>-<model>-<timestamp>.json` with the full traces, so failures can be read
 * and re-scored later. `--repeat` matters: model tool use is not deterministic, so one green
 * run proves little — report pass rates.
 */
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { doctolibCases } from './cases/doctolib.js';
import { hermesSystemPrompt, hermesToolResponse, parseHermesTurn, type ParsedCall } from './hermes-format.js';
import {
  scoreTrace,
  unknownTools,
  type CheckResult,
  type EvalCase,
  type ToolCallRecord,
  type Trace,
} from './scoring.js';

const CASE_SETS: Record<string, EvalCase[]> = { doctolib: doctolibCases };

const MAX_TURNS = 8;
/** Tool output handed back to the model is capped so one big search cannot blow the context. */
const MAX_TOOL_CHARS = 12_000;

interface Options {
  mcp: string;
  url: string;
  model?: string;
  repeat: number;
  caseId?: string;
  dryRun: boolean;
  toolMode: ToolMode;
}

type ToolMode = 'native' | 'prompted';

function parseArgs(argv: string[]): Options {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    mcp: get('--mcp') ?? 'doctolib',
    url: get('--url') ?? `http://localhost:${process.env.PORT ?? 3000}`,
    model: get('--model') ?? process.env.EVAL_MODEL,
    repeat: Math.max(1, Number(get('--repeat') ?? 1)),
    caseId: get('--case'),
    dryRun: argv.includes('--dry-run'),
    toolMode: get('--tool-mode') === 'prompted' ? 'prompted' : 'native',
  };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

async function chat(
  model: string,
  messages: ChatMessage[],
  tools: unknown[],
): Promise<{ message: ChatMessage; usage?: Usage }> {
  const base = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  let res: Response;
  let data: { choices?: { message: ChatMessage }[]; usage?: Usage; error?: { code?: number } };
  // Free models are rate-limited and their providers overload: back off on 429/5xx — which
  // OpenRouter sometimes reports inside a 200 body — instead of failing the case.
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'X-Title': 'personal-context-mcp agent eval',
      },
      // Prompted mode sends no `tools`: the signatures live in the system prompt instead.
      body: JSON.stringify({ model, messages, ...(tools.length ? { tools } : {}), temperature: 0 }),
    });
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
    const code = res.ok ? (data.error?.code ?? 200) : res.status;
    // The free tier's daily cap also answers 429, but no backoff will clear it before tomorrow.
    const dailyCap = /per-day/i.test(text);
    const retryable = !dailyCap && (code === 429 || code >= 500);
    if (!retryable || attempt >= 4) {
      if (!res.ok) {
        throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`);
      }
      break;
    }
    const wait = Number(res.headers.get('retry-after')) * 1000 || 5000 * 2 ** attempt;
    console.log(`        (provider busy: ${code}, retrying in ${Math.round(wait / 1000)}s)`);
    await new Promise((r) => setTimeout(r, wait));
  }
  const message = data.choices?.[0]?.message;
  if (!message) {
    throw new Error(`OpenRouter returned no choice: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return { message, usage: data.usage };
}

async function connect(url: string): Promise<Client> {
  const token = process.env.MCP_BEARER_TOKEN;
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  const client = new Client({ name: 'agent-eval', version: '0.1.0' });
  await client.connect(transport);
  return client;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** Call one MCP tool; failures come back as text so the model can see and react to them. */
async function invoke(client: Client, call: ParsedCall): Promise<{ record: ToolCallRecord; text: string }> {
  const t0 = Date.now();
  let text: string;
  let isError = false;
  try {
    const result = await client.callTool({ name: call.name, arguments: call.args });
    isError = Boolean(result.isError);
    text = (result.content as { type: string; text?: string }[]).map((c) => c.text ?? '').join('\n');
  } catch (error) {
    isError = true;
    text = `Tool call failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  return {
    record: { tool: call.name, args: call.args, isError, ms: Date.now() - t0 },
    text: text.slice(0, MAX_TOOL_CHARS),
  };
}

async function runCase(
  client: Client,
  model: string,
  mode: ToolMode,
  instructions: string,
  mcpTools: McpTool[],
  spec: EvalCase,
): Promise<Trace & { tokens: Usage; ms: number }> {
  const started = Date.now();
  const tokens: Usage = { prompt_tokens: 0, completion_tokens: 0 };
  const calls: ToolCallRecord[] = [];
  const formatErrors: string[] = [];
  const preamble =
    `You are a helpful assistant. Today is ${new Date().toISOString().slice(0, 10)}. ` +
    `You have tools from an MCP server whose instructions are:\n\n${instructions}\n\n` +
    'Use the tools only when they help with the request.';
  const promptedTools = mcpTools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    parameters: t.inputSchema,
  }));
  const apiTools = mode === 'native' ? promptedTools.map((t) => ({ type: 'function', function: t })) : [];
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: mode === 'native' ? preamble : hermesSystemPrompt(promptedTools, preamble),
    },
    { role: 'user', content: spec.prompt },
  ];
  const done = (extra: Partial<Trace>): Trace & { tokens: Usage; ms: number } => ({
    calls,
    answer: '',
    ...(formatErrors.length ? { formatErrors } : {}),
    ...extra,
    tokens,
    ms: Date.now() - started,
  });

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const { message, usage } = await chat(model, messages, apiTools);
      tokens.prompt_tokens += usage?.prompt_tokens ?? 0;
      tokens.completion_tokens += usage?.completion_tokens ?? 0;

      if (mode === 'native') {
        messages.push({ role: 'assistant', content: message.content ?? '', tool_calls: message.tool_calls });
        if (!message.tool_calls?.length) {
          return done({ answer: message.content ?? '' });
        }
        for (const tc of message.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch {
            // Recorded for parity with prompted mode, then sent as {} so the tool reports it.
            formatErrors.push(`bad arguments JSON: ${tc.function.arguments.slice(0, 120)}`);
          }
          const { record, text } = await invoke(client, { name: tc.function.name, args });
          calls.push(record);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: text });
        }
        continue;
      }

      // Prompted: calls are parsed out of the text; results go back as a user turn of
      // <tool_response> blocks, since there is no native tool_call_id to answer.
      const content = message.content ?? '';
      messages.push({ role: 'assistant', content });
      const parsed = parseHermesTurn(content);
      formatErrors.push(...parsed.formatErrors);
      if (!parsed.calls.length && !parsed.formatErrors.length) {
        return done({ answer: parsed.text });
      }
      const responses: string[] = [];
      for (const call of parsed.calls) {
        const { record, text } = await invoke(client, call);
        calls.push(record);
        responses.push(hermesToolResponse(call.name, text));
      }
      for (const err of parsed.formatErrors) {
        responses.push(hermesToolResponse('error', `Could not parse your <tool_call>: ${err}`));
      }
      messages.push({ role: 'user', content: responses.join('\n') });
    }
    return done({ aborted: `no answer after ${MAX_TURNS} turns` });
  } catch (error) {
    return done({ aborted: error instanceof Error ? error.message : String(error) });
  }
}

/** Re-apply the current checks to a saved results file — free, no LLM or MCP calls. */
function rescore(file: string): void {
  const saved = JSON.parse(readFileSync(file, 'utf8')) as {
    model: string;
    toolMode?: string;
    runs: { case: string; run: number; trace: Trace; infraError?: string }[];
  };
  const specs = new Map(
    Object.values(CASE_SETS)
      .flat()
      .map((c) => [c.id, c]),
  );
  console.log(`rescoring ${file} (${saved.model}, ${saved.toolMode ?? 'native'})`);
  for (const r of saved.runs) {
    const spec = specs.get(r.case);
    if (!spec || r.infraError) {
      console.log(`skip  ${r.case} #${r.run}${r.infraError ? ' (ERR)' : ' (case removed)'}`);
      continue;
    }
    const failed = scoreTrace(spec, r.trace).filter((c) => !c.pass);
    console.log(`${failed.length ? 'FAIL' : 'pass'}  ${r.case} #${r.run}`);
    for (const f of failed) {
      console.log(`        ✗ ${f.check}${f.detail ? ` — ${f.detail}` : ''}`);
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const rescoreFile = argv[argv.indexOf('--rescore') + 1];
  if (argv.includes('--rescore') && rescoreFile) {
    rescore(rescoreFile);
    return;
  }
  const opts = parseArgs(argv);
  const cases = (CASE_SETS[opts.mcp] ?? []).filter((c) => !opts.caseId || c.id === opts.caseId);
  if (!cases.length) {
    throw new Error(`No cases for --mcp ${opts.mcp}${opts.caseId ? ` --case ${opts.caseId}` : ''}`);
  }

  const endpoint = `${opts.url.replace(/\/$/, '')}/${opts.mcp}`;
  const client = await connect(endpoint);
  const { tools: mcpTools } = await client.listTools();
  const instructions = client.getInstructions() ?? '';
  const available = new Set(mcpTools.map((t) => t.name));

  // Broken cases are a harness bug, not a model failure — fail before spending tokens.
  const broken = cases.flatMap((c) => unknownTools(c, available).map((t) => `${c.id}: ${t}`));
  if (broken.length) {
    throw new Error(`Cases name tools the server does not expose: ${broken.join('; ')}`);
  }
  console.log(`${endpoint}: ${mcpTools.length} tools, ${cases.length} cases`);

  if (opts.dryRun) {
    for (const c of cases) {
      console.log(`  ${c.id.padEnd(24)} ${c.probes}`);
    }
    await client.close();
    return;
  }
  if (!opts.model) {
    throw new Error('Pass --model <openrouter-model-id> (or set EVAL_MODEL)');
  }
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not set (put it in .env)');
  }

  console.log(`model ${opts.model}, tool mode: ${opts.toolMode}`);

  const runs: {
    case: string;
    run: number;
    checks: CheckResult[];
    trace: Trace;
    tokens: Usage;
    ms: number;
    infraError?: string;
  }[] = [];
  for (const spec of cases) {
    for (let run = 1; run <= opts.repeat; run++) {
      const { tokens, ms, ...trace } = await runCase(
        client,
        opts.model,
        opts.toolMode,
        instructions,
        mcpTools,
        spec,
      );
      const checks = scoreTrace(spec, trace);
      // An LLM API failure says nothing about the model's tool use: report it, don't score it.
      const infraError = trace.aborted?.startsWith('OpenRouter') ? trace.aborted : undefined;
      runs.push({ case: spec.id, run, checks, trace, tokens, ms, ...(infraError ? { infraError } : {}) });
      const failed = checks.filter((c) => !c.pass);
      console.log(
        `${infraError ? 'ERR ' : failed.length ? 'FAIL' : 'pass'}  ${spec.id} #${run}  ` +
          `${trace.calls.length} calls, ${tokens.prompt_tokens + tokens.completion_tokens} tok, ${(ms / 1000).toFixed(1)}s`,
      );
      if (infraError) {
        console.log(`        ! not scored: ${infraError.slice(0, 160)}`);
        continue;
      }
      for (const f of failed) {
        console.log(`        ✗ ${f.check}${f.detail ? ` — ${f.detail}` : ''}`);
      }
      for (const e of trace.formatErrors ?? []) {
        console.log(`        ~ unparseable tool call: ${e.slice(0, 140)}`);
      }
    }
  }
  await client.close();

  const scored = runs.filter((r) => !r.infraError);
  const passed = scored.filter((r) => r.checks.every((c) => c.pass)).length;
  const errors = runs.length - scored.length;
  const sum = (f: (r: (typeof scored)[number]) => number): number => scored.reduce((acc, r) => acc + f(r), 0);
  const avg = (n: number): string => (scored.length ? (n / scored.length).toFixed(1) : '-');
  console.log(
    `\n${passed}/${scored.length} scored runs passed (${opts.model}, ${opts.toolMode})` +
      (errors ? `, ${errors} not scored (LLM API errors)` : ''),
  );
  console.log(
    `  avg ${avg(sum((r) => r.trace.calls.length))} tool calls, ` +
      `avg ${avg(sum((r) => r.tokens.prompt_tokens + r.tokens.completion_tokens))} tokens, ` +
      `${sum((r) => r.trace.formatErrors?.length ?? 0)} unparseable tool calls`,
  );
  for (const spec of cases) {
    const mine = scored.filter((r) => r.case === spec.id);
    const ok = mine.filter((r) => r.checks.every((c) => c.pass)).length;
    const err = runs.filter((r) => r.case === spec.id && r.infraError).length;
    console.log(`  ${spec.id.padEnd(24)} ${ok}/${mine.length}${err ? `  (+${err} ERR)` : ''}`);
  }

  mkdirSync('eval-results', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `eval-results/${opts.mcp}-${opts.model.replace(/[^\w.-]+/g, '_')}-${opts.toolMode}-${stamp}.json`;
  writeFileSync(
    file,
    JSON.stringify(
      { endpoint, model: opts.model, toolMode: opts.toolMode, repeat: opts.repeat, runs },
      null,
      2,
    ),
  );
  console.log(`traces: ${file}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
