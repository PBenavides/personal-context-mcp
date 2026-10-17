import type { EvalCase } from '../scoring.js';

/**
 * Agent eval cases for the doctolib MCP. Each probes one thing a model can get wrong with these
 * tools; together they cover tool selection, argument mapping, the silent zero-hit slug trap,
 * switching to a different visit motive, the read-only boundary, and staying out of scope.
 * These hit the live doctolib.de API.
 *
 * Call budgets are tight on purpose: one doctolib_search answers most of these (slugs are in
 * its schema, booking links in its results), so extra calls are what the budget measures.
 */
export const doctolibCases: EvalCase[] = [
  {
    id: 'earliest-dentist',
    probes: 'one search with the verified dentist slug, not "zahnarzt"',
    prompt: 'Find me the earliest dentist appointment in Berlin in the next two weeks.',
    expectCalls: [{ tool: 'doctolib_search', args: { specialty: 'zahnmedizin' } }],
    maxToolCalls: 2,
    answerMatches: ['20\\d\\d-\\d\\d-\\d\\d|\\d{1,2}\\.\\s?\\d{1,2}\\.|october|oktober|november'],
  },
  {
    id: 'english-gp-public',
    probes: 'maps "English-speaking" (Doctolib code "gb") and "public insurance" onto the filters',
    prompt:
      'I have public health insurance and need an English-speaking GP in Berlin. Who has the soonest slot?',
    expectCalls: [
      {
        tool: 'doctolib_search',
        args: {
          specialty: { oneOf: ['allgemeinmedizin', 'hausarztlich-tatige-internist-in'] },
          // Doctolib codes English as "gb"; the server aliases "en", so either is a correct call.
          languages: { oneOf: ['gb', 'en'] },
          insurance_sector: 'public',
        },
      },
    ],
    maxToolCalls: 2,
    // Without an answer check, a run that ends on a garbled tool call instead of a reply
    // passed (seen live in prompted mode).
    answerMatches: ['doctolib\\.de/'],
  },
  {
    id: 'dermatologist-hamburg',
    probes: 'reaches the right slug (hautarzt) for a specialty whose obvious spelling returns nothing',
    prompt: 'Is there a dermatologist in Hamburg with an opening this month?',
    expectCalls: [
      { tool: 'doctolib_search', args: { specialty: 'hautarzt', city: { contains: 'hamburg' } } },
    ],
    maxToolCalls: 3,
  },
  {
    id: 'new-patient-motive',
    probes: 'switches from the motive search matched to a new-patient one via doctolib_practitioner',
    prompt:
      'Find a dentist in Berlin, then tell me when they have a first examination for new patients ' +
      '(not an emergency/pain slot).',
    expectCalls: [
      { tool: 'doctolib_search' },
      { tool: 'doctolib_practitioner', args: { visit_motive_id: { present: true } } },
    ],
    maxToolCalls: 5,
    answerMatches: [
      '20\\d\\d-\\d\\d-\\d\\d|\\d{1,2}\\.\\s?\\d{1,2}\\.|no (open|available)|not (yet )?(open|released)',
    ],
  },
  {
    id: 'book-request',
    probes: 'does not claim a booking it cannot make; hands off a link instead',
    prompt: 'Book me the earliest GP appointment in Berlin.',
    expectCalls: [{ tool: 'doctolib_search' }],
    maxToolCalls: 2,
    answerMatches: ['doctolib\\.de/'],
    answerNotMatches: ["\\b(i'?ve|i have|successfully|is now|has been) booked\\b", 'booking (is )?confirmed'],
  },
  {
    id: 'out-of-scope',
    probes: 'tool-selection precision: no Doctolib calls for an unrelated question',
    prompt: 'What is the capital of Australia?',
    forbidTools: ['*'],
    answerMatches: ['canberra'],
  },
];
