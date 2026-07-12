# Development & operations

Governance, CI/CD, versioning, and the gap between what's declared in this
repo's tooling and what actually exists today.

## Ownership & catalog metadata

- [`catalog-info.yaml`](../catalog-info.yaml) — Backstage component
  registration: `type: service`, `lifecycle: experimental`,
  `domain: tech-foundation`, `owner: ai-engineering`.
- [`.github/CODEOWNERS`](../.github/CODEOWNERS) — `@taxfix/ai-engineering`
  owns the entire repo (single `*` rule).
- [`.github/dependabot.yml`](../.github/dependabot.yml) — weekly updates for
  the `github-actions` ecosystem only. There is no `npm` ecosystem entry yet,
  because there is no `package.json` to scan.

## CI

- [`.github/workflows/example.yaml`](../.github/workflows/example.yaml) is a
  **template**, not a finished pipeline. It currently only runs
  `software-catalog-validation` (validates `catalog-info.yaml` via a Taxfix
  reusable workflow). The file's own comments point at two reusable
  workflows meant to be uncommented once the project fits one of these
  shapes:
  - `taxfix/actions/.github/workflows/npm-package--common-targets.yml` — for
    an npm-package-style repo (build/test/publish).
  - `taxfix/actions/.github/workflows/container-based-application--common-targets.yml`
    — for a container-based deployable.

  Given this service builds a Docker image (see `Makefile` below), the
  container-based workflow is the more likely fit once enabled.
- [`.github/workflows/merge-gatekeeper.yaml`](../.github/workflows/merge-gatekeeper.yaml)
  — gates PR merges via Taxfix's shared `merge-gatekeeper` reusable workflow
  (runs on PR open/sync/reopen).
- [`.github/workflows/release-please.yaml`](../.github/workflows/release-please.yaml)
  — runs `googleapis/release-please-action` (see Versioning below).

## Versioning & releases

- [`release-please-config.json`](../release-please-config.json) —
  `release-type: node`, tags include a `v` prefix but not the component name,
  single package at `.`.
- [`.release-please-manifest.json`](../.release-please-manifest.json) —
  current tracked version: `0.0.1`.

This means releases are driven by [Conventional
Commits](https://www.conventionalcommits.org/) on `main`: release-please
opens/updates a release PR that bumps the version. Since `release-type` is
`node`, it expects to bump a `package.json` — which, per the gap list below,
doesn't exist yet. Once one is added, its `version` field becomes the single
version source the rest of the app reads via `getAppVersion()` (see
[Server & hosting](./server-and-hosting.md#versioning--srcversionts)) —
i.e. release-please's version bumps are what change the service's (and every
mounted MCP's) advertised version.

## Local tooling — `Makefile`

```
bootstrap, dependencies, format, lint, test  → all "Noop" today
build   → docker build (needs a Dockerfile, which doesn't exist yet)
check   → dependencies + lint + test + build
```

This follows Taxfix's standard Makefile convention
(`TAXFIX_MAKEFILE_VERSION=1`) for cross-repo consistency (CI can always run
`make check` regardless of stack), but every target except `build` is a
placeholder. `build` itself will fail today since there is no `Dockerfile`.

## Scaffolding (now present)

The runtime scaffolding the `src/` code assumes has landed on
`ts-implementation`:

| File | Provides |
|---|---|
| `package.json` | Dependencies (`fastify`, `zod`, `yaml`, `config`, `@modelcontextprotocol/sdk`, `dotenv`, `pino`, `@fastify/*`), the `name`/`version` read by `src/version.ts`, npm scripts. |
| `tsconfig.json` | Compiling `src/` → `dist/` (NodeNext ESM). |
| `jest.config.mjs` | Running the `*.test.ts` files (ts-jest ESM). |
| `.eslintrc.cjs` / `.prettierrc` | The `lint`/`format` Makefile targets. |
| `config/{default,custom-environment-variables,test}.json` | `src/config.ts` reads `port`/`jwt`/`logger`/`connections`/`security` via the `config` package. |
| `resource-files/` | Bundled per-MCP data; `context-layer`'s demo BM25 corpus lives at `resource-files/context-layer/`. |
| `Dockerfile` / `.dockerignore` | The `build` target and container image; all dependencies are public, so the build needs no registry credentials. |

`make dependencies|format|lint|test` now delegate to the npm scripts.

## Remaining follow-ups

- **CI pipeline** — `.github/workflows/example.yaml` still only validates the
  catalog; enable the container-based reusable workflow now that a `Dockerfile`
  exists.
- **Real corpus content** — `resource-files/context-layer/` currently holds
  demo/test content only; populating real Taxfix knowledge-base content is a
  separate follow-up.

See [Current gaps](./current-gaps.md) for the MCP-design validation and what was
verified locally.
