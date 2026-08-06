import { XMLParser } from 'fast-xml-parser';
import type { NodeAttribute, OntologyEdge, OntologyGraph, OntologyNode } from './model.js';
import { emptyGraph } from './model.js';
import {
  CLASSES,
  DATATYPE_PROPERTIES,
  DCTERMS_NS,
  getDatatypeProperty,
  getObjectProperty,
  OBJECT_PROPERTIES,
  ONTOLOGY_IRI,
  OWL_NS,
  PC_NS,
  RDF_NS,
  RDFS_NS,
  ROOT_CLASS,
  XSD_NS,
} from './vocabulary.js';

/**
 * RDF/XML persistence format.
 *
 * `serializeSchema()` renders the vocabulary as an OWL TBox (`schema.owl`): one owl:Class per
 * taxonomy category, datatype properties (functional ones as owl:FunctionalProperty), object
 * properties with rdfs:domain/range, and owl:Restriction blocks for max-cardinality limits.
 *
 * `serializeGraph()` renders the ABox (`data.rdf`): one typed element per node carrying its
 * literal attributes and edge references plus node-level dcterms:created/modified, and one
 * reified rdf:Statement per attribute/edge assertion carrying that assertion's own
 * created/modified. Reification keeps per-edge and per-attribute timestamps inside the RDF
 * itself, which is what the /visual-ontologies dashboard reads.
 *
 * `parseGraph()` reads the same format back (fast-xml-parser); serialize→parse is a lossless
 * round trip of the working model.
 */

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const XMLNS =
  `xmlns:rdf="${RDF_NS}" xmlns:rdfs="${RDFS_NS}" xmlns:owl="${OWL_NS}" ` +
  `xmlns:xsd="${XSD_NS}" xmlns:dcterms="${DCTERMS_NS}" xmlns:pc="${PC_NS}"`;

const DATETIME_TYPE = `${XSD_NS}dateTime`;

function literal(tag: string, value: string, datatype?: string): string {
  const dt = datatype ? ` rdf:datatype="${datatype}"` : '';
  return `    <${tag}${dt}>${esc(value)}</${tag}>`;
}

function stamps(created: string, modified: string): string[] {
  return [
    literal('dcterms:created', created, DATETIME_TYPE),
    literal('dcterms:modified', modified, DATETIME_TYPE),
  ];
}

/** The OWL TBox as RDF/XML — content of `schema.owl`. */
export function serializeSchema(): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(`<rdf:RDF ${XMLNS}>`);
  lines.push(`  <owl:Ontology rdf:about="${ONTOLOGY_IRI}">`);
  lines.push(
    literal(
      'rdfs:comment',
      'Personal-context ontology: the 14-category taxonomy as OWL classes with datatype and object properties.',
    ),
  );
  lines.push('  </owl:Ontology>');

  lines.push(`  <owl:Class rdf:about="${PC_NS}${ROOT_CLASS}">`);
  lines.push(literal('rdfs:label', ROOT_CLASS));
  lines.push('  </owl:Class>');

  // Max-cardinality restrictions grouped by the domain class they constrain.
  const restrictionsByClass = new Map<string, { property: string; max: number }[]>();
  for (const prop of OBJECT_PROPERTIES) {
    if (prop.maxCardinality !== undefined) {
      const list = restrictionsByClass.get(prop.domain) ?? [];
      list.push({ property: prop.name, max: prop.maxCardinality });
      restrictionsByClass.set(prop.domain, list);
    }
  }

  for (const cls of CLASSES) {
    lines.push(`  <owl:Class rdf:about="${PC_NS}${cls}">`);
    lines.push(literal('rdfs:label', cls));
    lines.push(`    <rdfs:subClassOf rdf:resource="${PC_NS}${ROOT_CLASS}"/>`);
    for (const restriction of restrictionsByClass.get(cls) ?? []) {
      lines.push('    <rdfs:subClassOf>');
      lines.push('      <owl:Restriction>');
      lines.push(`        <owl:onProperty rdf:resource="${PC_NS}${restriction.property}"/>`);
      lines.push(
        `        <owl:maxCardinality rdf:datatype="${XSD_NS}nonNegativeInteger">` +
          `${restriction.max}</owl:maxCardinality>`,
      );
      lines.push('      </owl:Restriction>');
      lines.push('    </rdfs:subClassOf>');
    }
    lines.push('  </owl:Class>');
  }

  for (const prop of DATATYPE_PROPERTIES) {
    lines.push(`  <owl:DatatypeProperty rdf:about="${PC_NS}${prop.name}">`);
    lines.push(literal('rdfs:label', prop.name));
    lines.push(literal('rdfs:comment', prop.comment));
    lines.push(`    <rdfs:domain rdf:resource="${PC_NS}${prop.domain}"/>`);
    lines.push(`    <rdfs:range rdf:resource="${XSD_NS}${prop.range}"/>`);
    if (prop.functional) {
      lines.push(`    <rdf:type rdf:resource="${OWL_NS}FunctionalProperty"/>`);
    }
    lines.push('  </owl:DatatypeProperty>');
  }

  for (const prop of OBJECT_PROPERTIES) {
    lines.push(`  <owl:ObjectProperty rdf:about="${PC_NS}${prop.name}">`);
    lines.push(literal('rdfs:label', prop.name));
    lines.push(literal('rdfs:comment', prop.comment));
    lines.push(`    <rdfs:domain rdf:resource="${PC_NS}${prop.domain}"/>`);
    lines.push(`    <rdfs:range rdf:resource="${PC_NS}${prop.range}"/>`);
    lines.push('  </owl:ObjectProperty>');
  }

  lines.push('</rdf:RDF>');
  return lines.join('\n');
}

function statementIri(subject: string, predicate: string, objectKey: string): string {
  return `${PC_NS}stmt/${encodeURIComponent(`${subject}|${predicate}|${objectKey}`)}`;
}

function serializeStatement(
  subject: string,
  predicate: string,
  object: { resource: string } | { value: string; datatype?: string },
  created: string,
  modified: string,
): string[] {
  const objectKey = 'resource' in object ? object.resource : object.value;
  const lines: string[] = [];
  lines.push(`  <rdf:Statement rdf:about="${statementIri(subject, predicate, objectKey)}">`);
  lines.push(`    <rdf:subject rdf:resource="${PC_NS}${subject}"/>`);
  lines.push(`    <rdf:predicate rdf:resource="${PC_NS}${predicate}"/>`);
  if ('resource' in object) {
    lines.push(`    <rdf:object rdf:resource="${PC_NS}${object.resource}"/>`);
  } else {
    lines.push(literal('rdf:object', object.value, object.datatype));
  }
  lines.push(...stamps(created, modified));
  lines.push('  </rdf:Statement>');
  return lines;
}

/** The ABox as RDF/XML — content of `data.rdf`. */
export function serializeGraph(graph: OntologyGraph): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(`<rdf:RDF ${XMLNS}>`);

  const nodes = [...graph.nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  const edgesBySubject = new Map<string, OntologyEdge[]>();
  for (const edge of graph.edges) {
    const list = edgesBySubject.get(edge.subject) ?? [];
    list.push(edge);
    edgesBySubject.set(edge.subject, list);
  }

  for (const node of nodes) {
    lines.push(`  <pc:${node.class} rdf:about="${PC_NS}${node.id}">`);
    lines.push(literal('rdfs:label', node.label));
    for (const attr of node.attributes) {
      const def = getDatatypeProperty(attr.property);
      const datatype = def?.range === 'decimal' ? `${XSD_NS}decimal` : undefined;
      lines.push(literal(`pc:${attr.property}`, String(attr.value), datatype));
    }
    for (const edge of edgesBySubject.get(node.id) ?? []) {
      lines.push(`    <pc:${edge.predicate} rdf:resource="${PC_NS}${edge.object}"/>`);
    }
    lines.push(...stamps(node.created, node.modified));
    lines.push(`  </pc:${node.class}>`);
  }

  // Reified assertions: per-attribute and per-edge timestamps.
  for (const node of nodes) {
    for (const attr of node.attributes) {
      const def = getDatatypeProperty(attr.property);
      lines.push(
        ...serializeStatement(
          node.id,
          attr.property,
          {
            value: String(attr.value),
            datatype: def?.range === 'decimal' ? `${XSD_NS}decimal` : undefined,
          },
          attr.created,
          attr.modified,
        ),
      );
    }
  }
  for (const edge of graph.edges) {
    lines.push(
      ...serializeStatement(
        edge.subject,
        edge.predicate,
        { resource: edge.object },
        edge.created,
        edge.modified,
      ),
    );
  }

  lines.push('</rdf:RDF>');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type XmlNode = Record<string, unknown>;

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function textOf(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  if (value && typeof value === 'object' && '#text' in (value as XmlNode)) {
    return String((value as XmlNode)['#text']);
  }
  return '';
}

function localName(iri: string): string {
  return iri.startsWith(PC_NS) ? iri.slice(PC_NS.length) : iri;
}

function resourceOf(value: unknown): string {
  if (value && typeof value === 'object') {
    return localName(String((value as XmlNode)['@_rdf:about'] ?? (value as XmlNode)['@_rdf:resource'] ?? ''));
  }
  return '';
}

interface StatementStamp {
  created: string;
  modified: string;
}

/** Parses `data.rdf` back into the working model. */
export function parseGraph(xml: string): OntologyGraph {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    trimValues: true,
  });
  const doc = parser.parse(xml) as XmlNode;
  const root = (doc['rdf:RDF'] ?? {}) as XmlNode;
  const graph = emptyGraph();

  // Pass 1 — reified statements: assertion key → timestamps.
  const statementStamps = new Map<string, StatementStamp>();
  for (const stmt of asArray(root['rdf:Statement'] as XmlNode | XmlNode[] | undefined)) {
    const subject = resourceOf(stmt['rdf:subject']);
    const predicate = resourceOf(stmt['rdf:predicate']);
    const objectRaw = stmt['rdf:object'];
    const objectKey =
      objectRaw && typeof objectRaw === 'object' && '@_rdf:resource' in (objectRaw as XmlNode)
        ? resourceOf(objectRaw)
        : textOf(objectRaw);
    statementStamps.set(`${subject}|${predicate}|${objectKey}`, {
      created: textOf(stmt['dcterms:created']),
      modified: textOf(stmt['dcterms:modified']),
    });
  }

  const fallback = (subject: string, predicate: string, objectKey: string, dflt: StatementStamp): StatementStamp =>
    statementStamps.get(`${subject}|${predicate}|${objectKey}`) ?? dflt;

  // Pass 2 — typed node elements.
  for (const cls of CLASSES) {
    for (const el of asArray(root[`pc:${cls}`] as XmlNode | XmlNode[] | undefined)) {
      const id = localName(String(el['@_rdf:about'] ?? ''));
      if (!id) {
        continue;
      }
      const created = textOf(el['dcterms:created']);
      const modified = textOf(el['dcterms:modified']);
      const nodeStamp: StatementStamp = { created, modified };
      const attributes: NodeAttribute[] = [];

      for (const [key, raw] of Object.entries(el)) {
        if (!key.startsWith('pc:')) {
          continue;
        }
        const property = key.slice(3);
        if (getDatatypeProperty(property)) {
          const def = getDatatypeProperty(property);
          for (const item of asArray(raw as unknown as XmlNode | XmlNode[])) {
            const text = textOf(item);
            const value = def?.range === 'decimal' ? Number(text) : text;
            const stamp = fallback(id, property, text, nodeStamp);
            attributes.push({ property, value, created: stamp.created, modified: stamp.modified });
          }
        } else if (getObjectProperty(property)) {
          for (const item of asArray(raw as unknown as XmlNode | XmlNode[])) {
            const object = resourceOf(item);
            if (!object) {
              continue;
            }
            const stamp = fallback(id, property, object, nodeStamp);
            graph.edges.push({
              subject: id,
              predicate: property,
              object,
              created: stamp.created,
              modified: stamp.modified,
            });
          }
        }
      }

      const node: OntologyNode = {
        id,
        class: cls,
        label: textOf(el['rdfs:label']) || id,
        attributes,
        created,
        modified,
      };
      graph.nodes.set(id, node);
    }
  }

  return graph;
}
