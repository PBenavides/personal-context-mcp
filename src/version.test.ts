import { readFileSync } from 'node:fs';
import { getAppVersion, packageInfo } from './version.js';

const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as {
  name: string;
  version: string;
};

describe('packageInfo', () => {
  it('reads name and version from the service package.json', () => {
    expect(packageInfo().name).toBe(pkg.name);
    expect(packageInfo().version).toBe(pkg.version);
  });
});

describe('getAppVersion', () => {
  it('returns the service version from package.json', () => {
    expect(getAppVersion()).toBe(pkg.version);
  });
});
