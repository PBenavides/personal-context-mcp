/**
 * Jest configured for TypeScript ESM (matches the project's NodeNext + `.js`-specifier imports).
 * Run via `npm test` (sets `NODE_OPTIONS=--experimental-vm-modules`).
 */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  // Strip the `.js` from relative specifiers so ESM source imports resolve to the `.ts` under test.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: 'tsconfig.json' }],
  },
  testMatch: ['**/*.test.ts'],
  clearMocks: true,
};
