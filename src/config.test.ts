import { appConfig, normalizeExcludeCollections } from './config.js';

describe('appConfig', () => {
  it('loads the default port from the config package', () => {
    expect(appConfig.port).toBe(3000);
  });

  it('exposes jwt options with an unset jwksUri by default', () => {
    expect(appConfig.jwt).toBeDefined();
    expect(appConfig.jwt.jwksUri ?? '').toBe('');
  });

  it('defaults the context-layer collection denylist to empty', () => {
    expect(appConfig.contextLayer.excludeCollections).toEqual([]);
  });
});

describe('normalizeExcludeCollections', () => {
  it('passes a JSON array through, trimming blanks', () => {
    expect(normalizeExcludeCollections(['a', ' b ', ''])).toEqual(['a', 'b']);
  });

  it('splits a comma-separated env string into an array', () => {
    expect(normalizeExcludeCollections('test-notion, _system ,')).toEqual([
      'test-notion',
      '_system',
    ]);
  });

  it('treats an empty or missing value as no exclusions', () => {
    expect(normalizeExcludeCollections('')).toEqual([]);
    expect(normalizeExcludeCollections(undefined)).toEqual([]);
  });
});
