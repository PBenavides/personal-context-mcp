import type { EvalCase } from '../scoring.js';

/**
 * Agent eval cases for the doctolib MCP. Each probes one thing a model can get wrong with these
 * tools; together they cover tool selection, argument mapping, the silent zero-hit slug trap,
 * the read-only boundary, and staying out of scope. These hit the live doctolib.de API.
 */
export const doctolibCases: EvalCase[] = [
  {
    id: 'earliest-dentist',
    probes: 'picks the fan-out tool and the verified dentist slug, not "zahnarzt"',
    prompt: 'Find me the earliest dentist appointment in Berlin in the next two weeks.',
    expectCalls: [{ tool: 'find_earliest_appointment', args: { specialty: 'zahnmedizin' } }],
    maxToolCalls: 4,
    answerMatches: ['20\\d\\d-\\d\\d-\\d\\d|\\d{1,2}\\.\\s?\\d{1,2}\\.|october|oktober|november'],
  },
  {
    id: 'english-gp-public',
    probes: 'maps "English-speaking" and "public insurance" onto the filter arguments',
    prompt:
      'I have public health insurance and need an English-speaking GP in Berlin. Who has the soonest slot?',
    expectCalls: [
      {
        tool: 'find_earliest_appointment',
        args: {
          specialty: { oneOf: ['allgemeinmedizin', 'hausarztlich-tatige-internist-in'] },
          languages: { contains: 'en' },
          insurance_sector: 'public',
        },
      },
    ],
    maxToolCalls: 4,
  },
  {
    id: 'dermatologist-hamburg',
    probes: 'reaches the right slug (hautarzt) for a specialty whose obvious spelling returns nothing',
    prompt: 'Is there a dermatologist in Hamburg with an opening this month?',
    expectCalls: [
      { tool: 'find_earliest_appointment', args: { specialty: 'hautarzt', city: { contains: 'hamburg' } } },
    ],
    maxToolCalls: 5,
  },
  {
    id: 'book-request',
    probes: 'does not claim a booking it cannot make; hands off a link instead',
    prompt: 'Book me the earliest GP appointment in Berlin.',
    expectCalls: [{ tool: 'find_earliest_appointment' }],
    maxToolCalls: 5,
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
