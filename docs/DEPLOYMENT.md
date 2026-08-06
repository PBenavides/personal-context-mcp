# Deployment

How `personal-context-mcp` gets from a laptop-side change to the running
service, and how that connects to the Terraform root that provisions its AWS
dependencies. This doc lives in the app repo because it's the app's release
process; the infra repo (`personal-infra/context`) owns the AWS resources
themselves and the cost/hosting decision record.

See also: [`fable_plans/DEPLOY_AND_HOSTING.md`](../../fable_plans/DEPLOY_AND_HOSTING.md)
(cross-repo operator runbook) and
[`personal-infra/context/README.md`](../../personal-infra/context/README.md)
(the Terraform root's own docs, including the hosting decision).

## Mental model

**Compute is disposable (DigitalOcean); state is durable (AWS).** This
service and `context-pipeline` run as containers on an existing DigitalOcean
droplet (co-hosted with `slskd`, reachable only over Tailscale). Everything
that must survive — the vault raw layer, the enriched layer, the ontology
registry, and the S3 Vectors index — lives in S3/Bedrock. Terraform provisions
the AWS side only; it never touches the droplet. Destroying and recreating the
droplet is safe: `deploy.sh` rebuilds it from scratch and nothing on its disk
is precious.

```
laptop (build + terraform)          AWS (state + provisioned resources)         droplet (compute, disposable)
──────────────────────────          ──────────────────────────────────         ─────────────────────────────
make release  ───────────────────►  ECR: personal-context-mcp repo
terraform apply ─────────────────►  IAM user, SSM secrets, S3 Vectors index
deploy.sh  ───────────────────────► reads ECR URL + IAM key + SSM secrets ───►  pulls image, renders .env,
                                                                                 docker compose up -d mcp
```

## The Terraform root — `personal-infra/context`

An independent root with its own local state (`terraform.tfstate` — not
shared with any other stack). It provisions everything the droplet needs to
reach AWS, and nothing about compute:

| Resource | Purpose |
|---|---|
| `aws_ecr_repository.repos["personal-context-mcp"]` | where `make release` pushes images; lifecycle policy keeps the last 5 |
| `aws_iam_user.node` (`personal-context-node`) + `aws_iam_access_key.node` | the credentials rendered into the droplet's `.env` — **not** an EC2 instance role, since compute isn't EC2 |
| `aws_iam_user_policy.node_s3` | scopes that key to: read raw (`raw_prefix`), read+write enriched (`enriched_prefix`), read+write ontology (`ontology_prefix`) — nothing else on the bucket |
| `aws_s3vectors_vector_bucket.vectors` + `aws_s3vectors_index.notes` | the semantic search index `search_context` queries |
| `aws_iam_user_policy.node_vectors` | scopes the same droplet key to `s3vectors:*Vectors`/`GetIndex` on that one index, plus `bedrock:InvokeModel` restricted to the Titan v2 embed model — no other Bedrock model, no other index |
| `aws_ssm_parameter.secrets["*"]` | `SecureString` placeholders under `/personal-context/*` (`openrouter-api-key`, `mcp-bearer-token`, `ec-activity-token`, `ynab-token`, `hevy-api-key`) — Terraform creates the placeholder once and then `ignore_changes = [value]`; real values are set out-of-band with `aws ssm put-parameter --overwrite` and never enter state |

`variables.tf` pins the shared bucket (`personal-pbenavides`) and its three
prefixes (`raw_prefix`, `enriched_prefix`, `ontology_prefix`) — this is the
S3 layout contract the app's config and the pipeline's config must agree
with. Changing a prefix here without updating the app is how you get a
"works in `terraform plan`, 403s in prod" bug.

**What Terraform does *not* own:** the droplet itself (pre-existing, managed
by whatever provisioned `slskd`), the container images' contents, and the
actual secret values. It owns the *shape* of access, not the running service.

### Applying it

```bash
cd personal-infra/context
terraform init      # first time / after a provider bump
terraform plan       # always safe, no AWS mutation — do this first
terraform apply      # mutates the live AWS account — see permission note below
```

Run `terraform apply` whenever `main.tf`/`variables.tf` change — most
recently, the 2026-07-19 ontology layer required one `apply` to grant the
droplet's IAM user read/write on `ontology/*`. Routine app deploys (a code
change to this repo with no new AWS resource) need **no** Terraform step.

## Release flow (routine app change)

```bash
# 1. verify locally — typecheck, lint, unit tests, streamable-HTTP smoke test
make verify

# 2. build for the droplet's architecture (linux/amd64) and push to ECR
make release

# 3. ship to the droplet: pulls terraform outputs + SSM secrets, renders
#    .env, scp's compose/systemd files, pulls the new image, restarts the MCP
bash ../personal-infra/context/deploy/deploy.sh

# 4. verify the live, deployed stack (tailnet + AWS profile required)
cd ../personal-infra/context && ./verify.sh --live
```

`make release` (this repo's `Makefile`) resolves the ECR repo URL live via
`aws ecr describe-repositories` rather than hardcoding it, so it always
targets whatever Terraform provisioned — no copy-pasted ARNs to go stale.

`deploy.sh` (in the infra repo, not here) is the seam between the two repos:
it calls `terraform output` for the ECR URL and the droplet's IAM key, calls
`aws ssm get-parameter` for the app secrets, and only then touches the
droplet — rendering `.env`, `scp`-ing `docker-compose.yml` +
`pipeline.service`/`pipeline.timer`, ensuring a swapfile exists (the droplet
has ~425MB free RAM), logging in to ECR on the droplet, pulling images, and
running `docker compose up -d mcp` + enabling the pipeline timer. It's
idempotent — safe to rerun after a droplet rebuild or a secret rotation.

Placeholder secrets (`ynab-token`, `hevy-api-key`, `ec-activity-token` before
its upstream PR ships) degrade gracefully: `deploy.sh` detects the literal
string `PLACEHOLDER` and renders an empty env var instead, which cleanly
disables the dependent tools/source rather than failing the deploy.

## Adding a new AWS dependency

When a change needs a new AWS resource (a new SSM secret, a wider IAM
statement, a new bucket/index):

1. Add it to `personal-infra/context/main.tf` (+ `variables.tf`/`outputs.tf`
   as needed).
2. `terraform plan` locally, read the diff.
3. Surface `terraform apply` for the human to run (see permission note) —
   never work around the block by editing AWS state some other way (console,
   raw `aws` CLI calls) except for the one-time secret values themselves,
   which are deliberately kept **out** of Terraform (`ignore_changes`).
4. If the app needs new env at runtime, add it to both
   `personal-infra/context/deploy/docker-compose.yml` and the `ssm`/`cat`
   block in `deploy.sh` that renders `.env` — Terraform provisions the
   secret's *existence*, `deploy.sh` is what actually gets it to the
   container.
5. `make release` + `deploy.sh` as usual.

## The permission caveat

`terraform apply` and `deploy.sh` are both **blocked from auto-execution**:
the former mutates the live AWS account (IAM users/policies, SSM, ECR
lifecycle), the latter SSHes into and writes to a droplet that also runs
production `slskd` traffic. In auto mode, surface the exact command for the
human to run via `! <command>` rather than trying to route around the block.
Safe to run directly: `terraform plan`, `terraform validate`, `make verify`,
`make release` (ECR push only, no droplet contact), and reading SSM
parameters.

## Verifying a deploy

`personal-infra/context/verify.sh` is the authoritative check:

- **No args** (`./verify.sh`) — plan-only: `terraform fmt -check`,
  `terraform validate`, `terraform plan` against real state. Safe pre-apply,
  needs no tailnet/droplet access.
- **`--live`** — everything above, plus: the MCP is unreachable from the
  droplet's *public* IPv4 (ingress-scoping check), reachable and
  `/health`+`/ready` over the tailnet IP, a full protocol smoke test
  (`scripts/mcp_smoke.sh` from this repo) against the live bearer token from
  SSM, and `pipeline.timer` + the MCP container both `Up` on the droplet.

Run `--live` after every `deploy.sh`. A plan-only `verify.sh` is enough after
a Terraform-only change that hasn't been deployed yet.

## Data backfills

Schema or embedding changes (e.g. a new taxonomy field, a different Titan
model) need a **batch** pipeline run, not an incremental one — and it runs
from the laptop, not the droplet:

```bash
cd ../context-pipeline && \
  VECTOR_BUCKET=personal-context-vectors VECTOR_INDEX=context-notes \
  .venv/bin/python -m pipeline.cli run --mode batch --source all
```

The droplet's hourly `pipeline.timer` always runs incremental (skips
unchanged docs) — it's not the right tool for a backfill.

## Teardown

`terraform destroy` removes the AWS side (ECR repos, IAM user/key, SSM
parameters, the S3 Vectors bucket/index — **not** the raw/enriched S3 bucket,
which this root never created). On the droplet:
`cd /opt/personal-context && docker compose down && systemctl disable --now pipeline.timer`.
S3 data (raw, enriched, ontology, vectors) is untouched either way — a fresh
`terraform apply` + `deploy.sh` brings the whole stack back exactly as it was.
