import { appConfig } from './config.js';

describe('appConfig', () => {
  it('loads the default port from the config package', () => {
    expect(appConfig.port).toBe(3000);
  });

  it('defaults auth to an unset bearer token (unenforced, local dev)', () => {
    expect(appConfig.auth.bearerToken).toBe('');
  });

  it('defaults the enriched corpus to the file source over the test fixtures', () => {
    const corpus = appConfig.connections.enrichedCorpus;
    expect(corpus.source).toBe('file');
    expect(corpus.rootDir).toBe('tests/fixtures/enriched');
    expect(corpus.refreshSeconds).toBe(300);
  });
});
