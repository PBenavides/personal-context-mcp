import { createPostgresConnection } from './postgres.js';

describe('createPostgresConnection', () => {
  it('exposes the expected name and kind', () => {
    const conn = createPostgresConnection({ url: '' });
    expect(conn.name).toBe('postgres');
    expect(conn.kind).toBe('postgres');
  });

  it('always throws from get() — even when a url is provided — since it is a scaffold', () => {
    expect(() => createPostgresConnection({ url: '' }).get()).toThrow(
      /scaffold and not implemented/,
    );
    expect(() =>
      createPostgresConnection({ url: 'postgres://localhost/db' }).get(),
    ).toThrow(/scaffold and not implemented/);
  });

  it('healthCheck() reports "not configured (scaffold)" when no url is set', async () => {
    await expect(
      createPostgresConnection({ url: '' }).healthCheck(),
    ).resolves.toEqual({
      name: 'postgres',
      kind: 'postgres',
      ok: false,
      detail: 'not configured (scaffold)',
    });
  });

  it('healthCheck() reports "configured but not implemented" when a url is set', async () => {
    await expect(
      createPostgresConnection({
        url: 'postgres://localhost/db',
      }).healthCheck(),
    ).resolves.toEqual({
      name: 'postgres',
      kind: 'postgres',
      ok: false,
      detail: 'configured but not implemented',
    });
  });

  it('close() is a no-op that resolves', async () => {
    await expect(
      createPostgresConnection({ url: '' }).close(),
    ).resolves.toBeUndefined();
  });
});
