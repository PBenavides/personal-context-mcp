import {
  getDatatypeProperty,
  getObjectProperty,
  isClass,
  ROOT_CLASS,
  satisfies,
} from './vocabulary.js';

/**
 * The ABox working model: a typed property graph that round-trips to RDF/XML (`rdfxml.ts`).
 *
 * Every assertion — node existence, each attribute value, each edge — carries its own
 * created/modified timestamps; that is what the dashboard and tools surface as "when did
 * this change". Updates go through {@link applyUpdate}, which validates the whole batch
 * against the vocabulary first and only mutates when the batch is clean.
 */

/** One datatype-property assertion on a node. */
export interface NodeAttribute {
  property: string;
  value: string | number;
  created: string;
  modified: string;
}

export interface OntologyNode {
  /** IRI local name (`PC_NS + id`); slug: lowercase alphanumerics and hyphens. */
  id: string;
  class: string;
  label: string;
  attributes: NodeAttribute[];
  created: string;
  modified: string;
}

/** One object-property assertion between two nodes. */
export interface OntologyEdge {
  subject: string;
  predicate: string;
  object: string;
  created: string;
  modified: string;
}

export interface OntologyGraph {
  nodes: Map<string, OntologyNode>;
  edges: OntologyEdge[];
}

export function emptyGraph(): OntologyGraph {
  return { nodes: new Map(), edges: [] };
}

export function cloneGraph(graph: OntologyGraph): OntologyGraph {
  return {
    nodes: new Map(
      [...graph.nodes.entries()].map(([id, node]) => [
        id,
        { ...node, attributes: node.attributes.map(attr => ({ ...attr })) },
      ]),
    ),
    edges: graph.edges.map(edge => ({ ...edge })),
  };
}

export function edgeKey(edge: { subject: string; predicate: string; object: string }): string {
  return `${edge.subject}|${edge.predicate}|${edge.object}`;
}

/** Update payload — the shared shape of `ontology_update` and injector proposals. */
export interface NodeInput {
  id: string;
  class: string;
  label?: string;
  /** property → value(s); functional properties replace, multi-valued append. */
  attributes?: Record<string, string | number | Array<string | number>>;
}

export interface EdgeInput {
  subject: string;
  predicate: string;
  object: string;
}

/** Standalone attribute upsert (the `attributes` list of `ontology_update`). */
export interface AttributeInput {
  nodeId: string;
  property: string;
  value: string | number;
}

export interface UpdateInput {
  nodes?: NodeInput[];
  edges?: EdgeInput[];
  attributes?: AttributeInput[];
  removeNodes?: string[];
  removeEdges?: EdgeInput[];
}

export interface UpdateResult {
  ok: boolean;
  errors: string[];
  /** Node ids created or modified by the batch (drives re-embedding). */
  changedNodeIds: string[];
  nodesCreated: number;
  nodesUpdated: number;
  edgesCreated: number;
  edgesRemoved: number;
  nodesRemoved: number;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;

function validateAttributeValue(
  nodeClass: string,
  property: string,
  value: string | number,
  errors: string[],
): void {
  const def = getDatatypeProperty(property);
  if (!def) {
    errors.push(`unknown datatype property "${property}"`);
    return;
  }
  if (!satisfies(nodeClass, def.domain)) {
    errors.push(`property "${property}" applies to ${def.domain}, not ${nodeClass}`);
  }
  if (def.range === 'decimal') {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      errors.push(`property "${property}" expects a number, got ${JSON.stringify(value)}`);
    }
  } else if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`property "${property}" expects a non-empty string`);
  }
  if (def.values && typeof value === 'string' && !def.values.includes(value)) {
    errors.push(
      `property "${property}" value "${value}" not in closed vocabulary [${def.values.join(', ')}]`,
    );
  }
}

interface NormalizedAttribute {
  nodeId: string;
  property: string;
  value: string | number;
}

/**
 * Validates and applies one update batch. All-or-nothing: when any input is invalid the graph
 * is untouched and `errors` explains every problem found (the injector feeds these back to
 * the LLM verbatim).
 */
export function applyUpdate(graph: OntologyGraph, input: UpdateInput, now: string): UpdateResult {
  const errors: string[] = [];
  const nodes = input.nodes ?? [];
  const edges = input.edges ?? [];
  const removeNodes = input.removeNodes ?? [];
  const removeEdges = input.removeEdges ?? [];

  // Class of every node after the batch (existing + incoming), for domain/range checks.
  const classAfter = new Map<string, string>();
  for (const [id, node] of graph.nodes) {
    classAfter.set(id, node.class);
  }

  for (const node of nodes) {
    if (!ID_PATTERN.test(node.id)) {
      errors.push(`node id "${node.id}" must be a lowercase slug (a-z, 0-9, hyphens)`);
      continue;
    }
    if (!isClass(node.class) || node.class === ROOT_CLASS) {
      errors.push(`node "${node.id}" has unknown class "${node.class}"`);
      continue;
    }
    const existing = graph.nodes.get(node.id);
    if (existing && existing.class !== node.class) {
      errors.push(
        `node "${node.id}" already exists as ${existing.class}; cannot re-type to ${node.class}`,
      );
      continue;
    }
    classAfter.set(node.id, node.class);
  }

  // Flatten node-embedded attributes and standalone attribute upserts into one list.
  const attrInputs: NormalizedAttribute[] = [];
  for (const node of nodes) {
    for (const [property, raw] of Object.entries(node.attributes ?? {})) {
      for (const value of Array.isArray(raw) ? raw : [raw]) {
        attrInputs.push({ nodeId: node.id, property, value });
      }
    }
  }
  for (const attr of input.attributes ?? []) {
    attrInputs.push({ nodeId: attr.nodeId, property: attr.property, value: attr.value });
  }

  for (const attr of attrInputs) {
    const cls = classAfter.get(attr.nodeId);
    if (!cls) {
      errors.push(`attribute on unknown node "${attr.nodeId}"`);
      continue;
    }
    validateAttributeValue(cls, attr.property, attr.value, errors);
  }

  for (const edge of edges) {
    const def = getObjectProperty(edge.predicate);
    if (!def) {
      errors.push(`unknown object property "${edge.predicate}"`);
      continue;
    }
    const subjectClass = classAfter.get(edge.subject);
    const objectClass = classAfter.get(edge.object);
    if (!subjectClass) {
      errors.push(`edge subject "${edge.subject}" is not a known node`);
    }
    if (!objectClass) {
      errors.push(`edge object "${edge.object}" is not a known node`);
    }
    if (!subjectClass || !objectClass) {
      continue;
    }
    if (!satisfies(subjectClass, def.domain)) {
      errors.push(
        `edge "${edge.predicate}" requires subject of class ${def.domain}, ` +
          `but "${edge.subject}" is ${subjectClass}`,
      );
    }
    if (!satisfies(objectClass, def.range)) {
      errors.push(
        `edge "${edge.predicate}" requires object of class ${def.range}, ` +
          `but "${edge.object}" is ${objectClass}`,
      );
    }
    if (edge.subject === edge.object) {
      errors.push(`edge "${edge.predicate}" cannot relate "${edge.subject}" to itself`);
    }
  }

  // Cardinality: count existing + incoming (deduplicated) assertions per subject+predicate.
  const removeKeys = new Set(removeEdges.map(edgeKey));
  const removedNodeSet = new Set(removeNodes);
  const perSubjectPredicate = new Map<string, Set<string>>();
  const countEdge = (edge: { subject: string; predicate: string; object: string }): void => {
    const key = `${edge.subject}|${edge.predicate}`;
    const objects = perSubjectPredicate.get(key) ?? new Set<string>();
    objects.add(edge.object);
    perSubjectPredicate.set(key, objects);
  };
  for (const edge of graph.edges) {
    if (!removeKeys.has(edgeKey(edge)) && !removedNodeSet.has(edge.subject) && !removedNodeSet.has(edge.object)) {
      countEdge(edge);
    }
  }
  for (const edge of edges) {
    countEdge(edge);
  }
  for (const [key, objects] of perSubjectPredicate) {
    const [subject, predicate] = key.split('|');
    const def = getObjectProperty(predicate);
    if (def?.maxCardinality !== undefined && objects.size > def.maxCardinality) {
      errors.push(
        `cardinality violation: "${subject}" would have ${objects.size} values for ` +
          `"${predicate}" (max ${def.maxCardinality})`,
      );
    }
  }

  for (const id of removeNodes) {
    if (!graph.nodes.has(id)) {
      errors.push(`cannot remove unknown node "${id}"`);
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      changedNodeIds: [],
      nodesCreated: 0,
      nodesUpdated: 0,
      edgesCreated: 0,
      edgesRemoved: 0,
      nodesRemoved: 0,
    };
  }

  // --- Apply (batch is clean) ---
  const changed = new Set<string>();
  let nodesCreated = 0;

  const existingEdgeKeys = new Set(graph.edges.map(edgeKey));
  const edgesRemovedCount = graph.edges.length;
  graph.edges = graph.edges.filter(
    edge =>
      !removeKeys.has(edgeKey(edge)) &&
      !removedNodeSet.has(edge.subject) &&
      !removedNodeSet.has(edge.object),
  );
  const edgesRemoved = edgesRemovedCount - graph.edges.length;
  for (const id of removeNodes) {
    graph.nodes.delete(id);
  }

  for (const node of nodes) {
    const existing = graph.nodes.get(node.id);
    if (!existing) {
      graph.nodes.set(node.id, {
        id: node.id,
        class: node.class,
        label: node.label?.trim() || node.id,
        attributes: [],
        created: now,
        modified: now,
      });
      nodesCreated += 1;
      changed.add(node.id);
    } else if (node.label && node.label.trim() && node.label.trim() !== existing.label) {
      existing.label = node.label.trim();
      existing.modified = now;
      changed.add(node.id);
    }
  }

  for (const attr of attrInputs) {
    const node = graph.nodes.get(attr.nodeId);
    if (!node) {
      continue; // removed in the same batch; nothing to assert on
    }
    const def = getDatatypeProperty(attr.property);
    if (def?.functional) {
      const current = node.attributes.find(a => a.property === attr.property);
      if (current) {
        if (current.value !== attr.value) {
          current.value = attr.value;
          current.modified = now;
          node.modified = now;
          changed.add(node.id);
        }
        continue;
      }
    } else if (
      node.attributes.some(a => a.property === attr.property && a.value === attr.value)
    ) {
      continue; // multi-valued duplicate — already asserted
    }
    node.attributes.push({ property: attr.property, value: attr.value, created: now, modified: now });
    node.modified = now;
    changed.add(node.id);
  }

  let edgesCreated = 0;
  for (const edge of edges) {
    const key = edgeKey(edge);
    if (existingEdgeKeys.has(key)) {
      continue;
    }
    existingEdgeKeys.add(key);
    graph.edges.push({ ...edge, created: now, modified: now });
    edgesCreated += 1;
    changed.add(edge.subject);
    changed.add(edge.object);
    const subjectNode = graph.nodes.get(edge.subject);
    const objectNode = graph.nodes.get(edge.object);
    if (subjectNode) subjectNode.modified = now;
    if (objectNode) objectNode.modified = now;
  }

  const createdIds = new Set(
    nodes.filter(n => changed.has(n.id) && graph.nodes.get(n.id)?.created === now).map(n => n.id),
  );

  return {
    ok: true,
    errors: [],
    changedNodeIds: [...changed].filter(id => graph.nodes.has(id)),
    nodesCreated,
    nodesUpdated: [...changed].filter(id => graph.nodes.has(id) && !createdIds.has(id)).length,
    edgesCreated,
    edgesRemoved,
    nodesRemoved: removeNodes.length,
  };
}

/** Text rendering of a node used for embeddings and keyword scoring. */
export function nodeText(node: OntologyNode): string {
  const attrs = node.attributes
    .filter(a => a.property !== 'sourcePath')
    .map(a => `${a.property}: ${a.value}`)
    .join('\n');
  return [`${node.label} (${node.class})`, attrs].filter(Boolean).join('\n');
}
