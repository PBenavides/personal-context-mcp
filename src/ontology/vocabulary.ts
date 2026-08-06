/**
 * The ontology vocabulary (TBox) — single source of truth for the OWL schema.
 *
 * Everything else derives from these tables: `rdfxml.ts` serializes them to `schema.owl`
 * (RDF/XML), `model.ts` validates ABox updates against them (classes, domains/ranges,
 * cardinalities), and the injector prompt renders them as the catalog the LLM routes
 * free-text into.
 *
 * The classes mirror the closed 14-category taxonomy from the enrichment pipeline
 * (`context-pipeline/pipeline/schema.py`) — the ontology is the graph-shaped view of the
 * same vocabulary, so injector routing never has to invent classes.
 */

/** Ontology namespace. Node IRIs are `PC_NS + node.id`. */
export const PC_NS = 'https://pbenavides.dev/ontology/personal-context#';
export const ONTOLOGY_IRI = 'https://pbenavides.dev/ontology/personal-context';

export const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const RDFS_NS = 'http://www.w3.org/2000/01/rdf-schema#';
export const OWL_NS = 'http://www.w3.org/2002/07/owl#';
export const XSD_NS = 'http://www.w3.org/2001/XMLSchema#';
export const DCTERMS_NS = 'http://purl.org/dc/terms/';

/** Root class; every taxonomy class is an owl:Class rdfs:subClassOf it. */
export const ROOT_CLASS = 'PersonalEntity';

/** The 14 taxonomy categories as OWL classes (closed vocabulary — same as the pipeline). */
export const CLASSES = [
  'Value',
  'Person',
  'HealthCondition',
  'Skill',
  'Constraint',
  'Habit',
  'FinancialItem',
  'Tool',
  'Goal',
  'Project',
  'Milestone',
  'Decision',
  'Situation',
  'Event',
] as const;

export type OntologyClass = (typeof CLASSES)[number];

export const HORIZONS = ['closing', 'near', 'mid', 'far', 'standing', 'deferred', 'cadence', 'past'];
export const STATUSES = ['proposed', 'active', 'dormant', 'done'];
export const SITUATION_SHAPES = ['Task', 'Thread', 'Loop'];

export interface DatatypePropertyDef {
  name: string;
  /** XSD range local name. */
  range: 'string' | 'decimal' | 'dateTime';
  /** owl:FunctionalProperty — at most one value per subject. */
  functional: boolean;
  /** Domain class; `PersonalEntity` admits every class. */
  domain: string;
  /** Closed value set, validated on update. */
  values?: readonly string[];
  comment: string;
}

export const DATATYPE_PROPERTIES: readonly DatatypePropertyDef[] = [
  {
    name: 'summary',
    range: 'string',
    functional: true,
    domain: ROOT_CLASS,
    comment: 'One-paragraph description of the entity.',
  },
  {
    name: 'status',
    range: 'string',
    functional: true,
    domain: ROOT_CLASS,
    values: STATUSES,
    comment: `Lifecycle status: ${STATUSES.join(' | ')}.`,
  },
  {
    name: 'horizon',
    range: 'string',
    functional: true,
    domain: ROOT_CLASS,
    values: HORIZONS,
    comment: `Time horizon: ${HORIZONS.join(' | ')}.`,
  },
  {
    name: 'salience',
    range: 'decimal',
    functional: true,
    domain: ROOT_CLASS,
    comment: 'How central the entity currently is, in [0, 1].',
  },
  {
    name: 'situationShape',
    range: 'string',
    functional: true,
    domain: 'Situation',
    values: SITUATION_SHAPES,
    comment: `Shape of a Situation: ${SITUATION_SHAPES.join(' | ')}.`,
  },
  {
    name: 'sourcePath',
    range: 'string',
    functional: false,
    domain: ROOT_CLASS,
    comment: 'Provenance: enriched-corpus document path(s) this entity was derived from.',
  },
  {
    name: 'note',
    range: 'string',
    functional: false,
    domain: ROOT_CLASS,
    comment: 'Free-text remark attached to the entity.',
  },
];

export interface ObjectPropertyDef {
  name: string;
  domain: string;
  range: string;
  /** Subject-side owl:maxCardinality restriction declared on the domain class. */
  maxCardinality?: number;
  comment: string;
}

export const OBJECT_PROPERTIES: readonly ObjectPropertyDef[] = [
  {
    name: 'relatesTo',
    domain: ROOT_CLASS,
    range: ROOT_CLASS,
    comment: 'Generic association when no sharper property fits.',
  },
  {
    name: 'involvesPerson',
    domain: ROOT_CLASS,
    range: 'Person',
    comment: 'A person participating in or affected by the entity.',
  },
  {
    name: 'contributesTo',
    domain: 'Project',
    range: 'Goal',
    comment: 'The goal a project advances.',
  },
  {
    name: 'milestoneOf',
    domain: 'Milestone',
    range: 'Project',
    maxCardinality: 1,
    comment: 'The single project a milestone belongs to.',
  },
  {
    name: 'motivatedBy',
    domain: ROOT_CLASS,
    range: 'Value',
    comment: 'The personal value that motivates the entity.',
  },
  {
    name: 'constrainedBy',
    domain: ROOT_CLASS,
    range: 'Constraint',
    comment: 'A constraint limiting the entity.',
  },
  {
    name: 'usesTool',
    domain: ROOT_CLASS,
    range: 'Tool',
    comment: 'A tool employed by the entity.',
  },
  {
    name: 'requiresSkill',
    domain: ROOT_CLASS,
    range: 'Skill',
    comment: 'A skill the entity depends on or develops.',
  },
  {
    name: 'supportsGoal',
    domain: 'Habit',
    range: 'Goal',
    comment: 'The goal a habit reinforces.',
  },
  {
    name: 'informedBy',
    domain: 'Decision',
    range: ROOT_CLASS,
    comment: 'Context (situation, constraint, value, …) that informed a decision.',
  },
  {
    name: 'concerns',
    domain: 'Event',
    range: ROOT_CLASS,
    comment: 'What an event was about.',
  },
];

const classSet = new Set<string>([ROOT_CLASS, ...CLASSES]);
const datatypeByName = new Map(DATATYPE_PROPERTIES.map(p => [p.name, p]));
const objectByName = new Map(OBJECT_PROPERTIES.map(p => [p.name, p]));

export function isClass(name: string): boolean {
  return classSet.has(name);
}

export function getDatatypeProperty(name: string): DatatypePropertyDef | undefined {
  return datatypeByName.get(name);
}

export function getObjectProperty(name: string): ObjectPropertyDef | undefined {
  return objectByName.get(name);
}

/** Whether `cls` satisfies a property `domain`/`range` (root admits every class). */
export function satisfies(cls: string, constraint: string): boolean {
  return constraint === ROOT_CLASS || cls === constraint;
}

/** Plain-text catalog of the vocabulary, rendered into the injector prompt. */
export function describeVocabulary(): string {
  const lines: string[] = [];
  lines.push(`Classes (choose exactly one per node): ${CLASSES.join(', ')}`);
  lines.push('');
  lines.push('Datatype properties (node attributes):');
  for (const p of DATATYPE_PROPERTIES) {
    const domain = p.domain === ROOT_CLASS ? 'any class' : `${p.domain} only`;
    const multi = p.functional ? 'single-valued' : 'multi-valued';
    lines.push(`- ${p.name} (${p.range}, ${domain}, ${multi}): ${p.comment}`);
  }
  lines.push('');
  lines.push('Object properties (edges, subject → object):');
  for (const p of OBJECT_PROPERTIES) {
    const card = p.maxCardinality !== undefined ? `, max ${p.maxCardinality} per subject` : '';
    lines.push(`- ${p.name}: ${p.domain} → ${p.range}${card}. ${p.comment}`);
  }
  return lines.join('\n');
}
