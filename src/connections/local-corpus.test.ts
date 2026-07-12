import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalCorpusConnection } from './local-corpus.js';

function writeFile(root: string, relativePath: string, content: string): void {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
}

describe('createLocalCorpusConnection', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-corpus-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('throws a clear error from get() when rootDir is empty', () => {
    const conn = createLocalCorpusConnection({ rootDir: '' });
    expect(() => conn.get()).toThrow(/not configured/);
  });

  it('throws a clear error from get() when rootDir does not exist', () => {
    const conn = createLocalCorpusConnection({
      rootDir: path.join(tmpRoot, 'nope'),
    });
    expect(() => conn.get()).toThrow(/not an existing directory/);
  });

  it('throws a clear error from get() when rootDir is a file, not a directory', () => {
    const filePath = path.join(tmpRoot, 'not-a-dir.txt');
    fs.writeFileSync(filePath, 'hello', 'utf-8');
    const conn = createLocalCorpusConnection({ rootDir: filePath });
    expect(() => conn.get()).toThrow(/not an existing directory/);
  });

  it('succeeds with zero collections when rootDir exists but is empty (valid, not an error)', () => {
    const conn = createLocalCorpusConnection({ rootDir: tmpRoot });
    const index = conn.get();
    expect(index.listCollections()).toEqual([]);
    expect(index.totalDocCount()).toBe(0);
  });

  it('discovers subdirectories as collections and recurses for included file extensions', () => {
    writeFile(tmpRoot, 'general/a.md', '# A\n\nSome content.');
    writeFile(tmpRoot, 'general/b.txt', 'plain text content');
    writeFile(tmpRoot, 'general/nested/c.md', '# C\n\nNested content.');
    writeFile(tmpRoot, 'general/ignored.json', '{"not": "included"}');
    writeFile(tmpRoot, 'general/.hidden.md', '# Hidden\n\nShould be skipped.');
    writeFile(tmpRoot, 'sensitive/d.md', '# D\n\nOther collection.');

    const conn = createLocalCorpusConnection({ rootDir: tmpRoot });
    const index = conn.get();

    expect(index.listCollections().sort()).toEqual(['general', 'sensitive']);
    expect(index.docCount('general')).toBe(3); // a.md, b.txt, nested/c.md — not ignored.json or .hidden.md
    expect(index.docCount('sensitive')).toBe(1);
    expect(index.totalDocCount()).toBe(4);
  });

  it('derives the title from the first markdown heading, else the filename', () => {
    writeFile(tmpRoot, 'general/has-heading.md', '# My Title\n\nBody text.');
    writeFile(tmpRoot, 'general/no-heading.md', 'Just some body text.');

    const conn = createLocalCorpusConnection({ rootDir: tmpRoot });
    const index = conn.get();
    const hits = index.search('general', 'title body text', 5);
    const byId = new Map(hits.map(h => [h.id, h.payload]));
    expect(byId.get('general/has-heading.md')?.title).toBe('My Title');
    expect(byId.get('general/no-heading.md')?.title).toBe('no heading');
  });

  it('scopes search to the requested collection only', () => {
    writeFile(tmpRoot, 'general/a.md', '# A\n\nUnique term zephyr appears here.');
    writeFile(tmpRoot, 'sensitive/b.md', '# B\n\nUnique term zephyr appears here too.');

    const conn = createLocalCorpusConnection({ rootDir: tmpRoot });
    const index = conn.get();
    const hits = index.search('general', 'zephyr', 5);
    expect(hits.map(h => h.id)).toEqual(['general/a.md']);
  });

  it('returns an empty array for an unknown collection', () => {
    writeFile(tmpRoot, 'general/a.md', '# A\n\nSome content.');
    const conn = createLocalCorpusConnection({ rootDir: tmpRoot });
    expect(conn.get().search('unknown', 'anything', 5)).toEqual([]);
  });

  it('memoises the built index across repeated get() calls', () => {
    let calls = 0;
    const conn = createLocalCorpusConnection(
      { rootDir: tmpRoot },
      {
        readCorpus: () => {
          calls += 1;
          return [];
        },
      },
    );
    conn.get();
    conn.get();
    expect(calls).toBe(1);
  });

  it('reports ok:false with a "not configured" detail when unconfigured', async () => {
    const conn = createLocalCorpusConnection({ rootDir: '' });
    await expect(conn.healthCheck()).resolves.toEqual({
      name: 'local-corpus',
      kind: 'local-corpus',
      ok: false,
      detail: 'not configured',
    });
  });

  it('reports ok:true with collection/document counts on a successful health check', async () => {
    writeFile(tmpRoot, 'general/a.md', '# A\n\nContent.');
    writeFile(tmpRoot, 'sensitive/b.md', '# B\n\nContent.');
    const conn = createLocalCorpusConnection({ rootDir: tmpRoot });
    await expect(conn.healthCheck()).resolves.toEqual({
      name: 'local-corpus',
      kind: 'local-corpus',
      ok: true,
      detail: '2 collections, 2 documents',
    });
  });

  it('reports ok:false with the error message when reading the corpus throws', async () => {
    const conn = createLocalCorpusConnection(
      { rootDir: tmpRoot },
      {
        readCorpus: () => {
          throw new Error('disk boom');
        },
      },
    );
    await expect(conn.healthCheck()).resolves.toEqual({
      name: 'local-corpus',
      kind: 'local-corpus',
      ok: false,
      detail: 'disk boom',
    });
  });

  it('close() is a no-op that resolves', async () => {
    const conn = createLocalCorpusConnection({ rootDir: tmpRoot });
    await expect(conn.close()).resolves.toBeUndefined();
  });
});
