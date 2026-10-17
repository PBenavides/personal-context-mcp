import { hermesSystemPrompt, hermesToolResponse, parseHermesTurn } from './hermes-format.js';

describe('parseHermesTurn', () => {
  it('parses several calls and leaves no answer text', () => {
    const out = parseHermesTurn(
      '<tool_call>\n{"name": "list_specialties", "arguments": {}}\n</tool_call>\n' +
        '<tool_call>{"name":"search_doctors","arguments":{"specialty":"hautarzt","city":"Hamburg"}}</tool_call>',
    );
    expect(out.calls).toEqual([
      { name: 'list_specialties', args: {} },
      { name: 'search_doctors', args: { specialty: 'hautarzt', city: 'Hamburg' } },
    ]);
    expect(out.formatErrors).toEqual([]);
    expect(out.text).toBe('');
  });

  it('accepts fenced JSON and double-encoded arguments', () => {
    const out = parseHermesTurn(
      '<tool_call>```json\n{"name":"booking_url","arguments":"{\\"profile_slug\\":\\"x\\"}"}\n```</tool_call>',
    );
    expect(out.calls).toEqual([{ name: 'booking_url', args: { profile_slug: 'x' } }]);
  });

  it('records malformed and truncated calls as format errors', () => {
    const out = parseHermesTurn(
      '<tool_call>{name: search_doctors}</tool_call><tool_call>{"name": "x", "arguments": {"a": 1',
    );
    expect(out.calls).toEqual([]);
    expect(out.formatErrors).toHaveLength(2);
  });

  it('flags a call written without its tags instead of taking it as the answer', () => {
    // Verbatim shape of a live Nemotron final turn in prompted mode.
    const out = parseHermesTurn('{"name": "booking_url", "arguments": {"profile_slug": "ali-hamdan"}} ```');
    expect(out.calls).toEqual([]);
    expect(out.formatErrors).toEqual([expect.stringMatching(/without <tool_call> tags/)]);
  });

  it('does not flag an answer that merely contains JSON', () => {
    const out = parseHermesTurn('The slot is {"date": "2026-10-19"} at 07:45.');
    expect(out.formatErrors).toEqual([]);
  });

  it('returns plain text, minus reasoning, as the answer', () => {
    const out = parseHermesTurn('<think>no tools needed</think>The capital of Australia is Canberra.');
    expect(out).toEqual({ calls: [], formatErrors: [], text: 'The capital of Australia is Canberra.' });
  });
});

describe('hermesSystemPrompt / hermesToolResponse', () => {
  it('embeds the signatures and the call format', () => {
    const prompt = hermesSystemPrompt(
      [{ name: 'list_specialties', description: 'd', parameters: { type: 'object' } }],
      'PRE',
    );
    expect(prompt.startsWith('PRE')).toBe(true);
    expect(prompt).toContain('"name":"list_specialties"');
    expect(prompt).toContain('<tool_call>');
  });

  it('wraps a result in tool_response tags', () => {
    expect(hermesToolResponse('t', 'ok')).toBe(
      '<tool_response>\n{"name":"t","content":"ok"}\n</tool_response>',
    );
  });
});
