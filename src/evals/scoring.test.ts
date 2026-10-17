import { doctolibCases } from './cases/doctolib.js';
import { scoreTrace, unknownTools, type EvalCase, type Trace } from './scoring.js';

const spec: EvalCase = {
  id: 't',
  probes: 'test',
  prompt: 'x',
  expectCalls: [{ tool: 'search', args: { specialty: 'zahnmedizin', languages: { contains: 'en' } } }],
  forbidTools: ['book'],
  maxToolCalls: 2,
  answerMatches: ['doctolib\\.de'],
  answerNotMatches: ['booked'],
};

function trace(partial: Partial<Trace>): Trace {
  return { calls: [], answer: '', ...partial };
}

function failures(t: Trace): string[] {
  return scoreTrace(spec, t)
    .filter((c) => !c.pass)
    .map((c) => c.check);
}

describe('scoreTrace', () => {
  it('passes a trace that satisfies every check', () => {
    const t = trace({
      calls: [
        {
          tool: 'search',
          args: { specialty: 'Zahnmedizin', languages: ['de', 'en'] },
          isError: false,
          ms: 1,
        },
      ],
      answer: 'See https://www.doctolib.de/zahnmedizin/berlin/x',
    });
    expect(failures(t)).toEqual([]);
  });

  it('names the wrong argument, the forbidden call, the overrun and the answer checks', () => {
    const t = trace({
      calls: [
        { tool: 'search', args: { specialty: 'zahnarzt' }, isError: false, ms: 1 },
        { tool: 'book', args: {}, isError: false, ms: 1 },
        { tool: 'search', args: {}, isError: false, ms: 1 },
      ],
      answer: 'I booked it.',
    });
    expect(failures(t)).toEqual([
      expect.stringMatching(/^calls search/),
      'avoids book',
      '≤ 2 tool calls',
      'answer ~ /doctolib\\.de/',
      'answer !~ /booked/',
    ]);
  });

  it('fails "completed" when the loop aborted', () => {
    expect(failures(trace({ aborted: 'turn limit' }))).toContain('completed');
  });

  it('treats "*" as forbidding every tool', () => {
    const results = scoreTrace(
      { id: 'o', probes: '', prompt: '', forbidTools: ['*'] },
      trace({ calls: [{ tool: 'anything', args: {}, isError: false, ms: 1 }] }),
    );
    expect(results.find((r) => r.check.startsWith('avoids'))?.pass).toBe(false);
  });
});

describe('doctolib cases', () => {
  it('only name tools the doctolib MCP exposes', () => {
    const tools = new Set([
      'list_specialties',
      'find_earliest_appointment',
      'search_doctors',
      'get_practitioner',
      'get_availabilities',
      'booking_url',
    ]);
    expect(doctolibCases.flatMap((c) => unknownTools(c, tools))).toEqual([]);
  });
});
