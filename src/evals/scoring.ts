/**
 * Deterministic scoring for agent evals: did a real LLM, given an MCP's tools and a task, pick
 * the right tools with the right arguments and give an answer that holds up? No LLM judge —
 * every check is a plain predicate over the recorded trace, so a failure names exactly what
 * went wrong and re-scoring an old trace is free. Runner: `agent-eval.ts`.
 */

/** Exact value, one of several, or a case-insensitive substring/element match. */
export type ArgMatcher =
  string | number | boolean | { oneOf: (string | number | boolean)[] } | { contains: string };

export interface EvalCase {
  id: string;
  /** What this case probes, e.g. "tool selection", "slug knowledge", "refuses to fake a booking". */
  probes: string;
  prompt: string;
  /** Each entry must be satisfied by at least one call (any order). */
  expectCalls?: { tool: string; args?: Record<string, ArgMatcher> }[];
  /** None of these tools may be called. `"*"` forbids every tool. */
  forbidTools?: string[];
  /** Upper bound on tool calls — catches flailing and redundant chains. */
  maxToolCalls?: number;
  /** Regexes (case-insensitive) the final answer must / must not match. */
  answerMatches?: string[];
  answerNotMatches?: string[];
}

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  isError: boolean;
  ms: number;
}

export interface Trace {
  calls: ToolCallRecord[];
  answer: string;
  /** Set when the loop ended without an answer (turn limit, API error). */
  aborted?: string;
}

export interface CheckResult {
  check: string;
  pass: boolean;
  detail?: string;
}

function matches(matcher: ArgMatcher, value: unknown): boolean {
  if (typeof matcher !== 'object') {
    return typeof matcher === 'string' && typeof value === 'string'
      ? matcher.toLowerCase() === value.toLowerCase()
      : matcher === value;
  }
  if ('oneOf' in matcher) {
    return matcher.oneOf.some((m) => matches(m, value));
  }
  const needle = matcher.contains.toLowerCase();
  if (Array.isArray(value)) {
    return value.some((v) => String(v).toLowerCase().includes(needle));
  }
  return value !== undefined && String(value).toLowerCase().includes(needle);
}

function describeCall(c: ToolCallRecord): string {
  return `${c.tool}(${JSON.stringify(c.args)})`;
}

export function scoreTrace(spec: EvalCase, trace: Trace): CheckResult[] {
  const results: CheckResult[] = [];

  results.push({
    check: 'completed',
    pass: !trace.aborted,
    ...(trace.aborted ? { detail: trace.aborted } : {}),
  });

  for (const expected of spec.expectCalls ?? []) {
    const label = `calls ${expected.tool}${expected.args ? ` ${JSON.stringify(expected.args)}` : ''}`;
    const hit = trace.calls.some(
      (c) =>
        c.tool === expected.tool &&
        Object.entries(expected.args ?? {}).every(([k, m]) => matches(m, c.args[k])),
    );
    results.push({
      check: label,
      pass: hit,
      ...(hit ? {} : { detail: `got: ${trace.calls.map(describeCall).join(', ') || 'no calls'}` }),
    });
  }

  if (spec.forbidTools?.length) {
    const bad = trace.calls.filter(
      (c) => spec.forbidTools?.includes('*') || spec.forbidTools?.includes(c.tool),
    );
    results.push({
      check: `avoids ${spec.forbidTools.join(', ')}`,
      pass: bad.length === 0,
      ...(bad.length ? { detail: bad.map(describeCall).join(', ') } : {}),
    });
  }

  if (spec.maxToolCalls !== undefined) {
    results.push({
      check: `≤ ${spec.maxToolCalls} tool calls`,
      pass: trace.calls.length <= spec.maxToolCalls,
      detail: `${trace.calls.length} calls`,
    });
  }

  for (const pattern of spec.answerMatches ?? []) {
    const pass = new RegExp(pattern, 'i').test(trace.answer);
    results.push({ check: `answer ~ /${pattern}/`, pass });
  }
  for (const pattern of spec.answerNotMatches ?? []) {
    const pass = !new RegExp(pattern, 'i').test(trace.answer);
    results.push({ check: `answer !~ /${pattern}/`, pass });
  }

  return results;
}

/** Tool names a case refers to that the server does not expose — a broken case, not a model failure. */
export function unknownTools(spec: EvalCase, available: ReadonlySet<string>): string[] {
  const named = [
    ...(spec.expectCalls ?? []).map((c) => c.tool),
    ...(spec.forbidTools ?? []).filter((t) => t !== '*'),
  ];
  return [...new Set(named)].filter((t) => !available.has(t));
}
