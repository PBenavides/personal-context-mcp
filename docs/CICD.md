# CI/CD — how a change reaches production

The rule: **nothing lands on `main` except through a PR, and everything on
`main` deploys itself.**

```
  branch ──PR──▶ CI (typecheck, lint, tests, smoke, docker build)
                  │
                  ▼  merge
                main ──▶ build + push to ECR (sha-<commit>, latest)
                          │
                          ▼  runner joins the tailnet
                        roll the mcp container ──▶ /ready + live MCP smoke
                          │                              │
                          └──────── failed? ─────────────┘
                                     ▼
                              automatic rollback
```

| | file | when |
|---|---|---|
| CI gate | `.github/workflows/ci.yml` | every PR into `main`, and `main` itself |
| CD | `.github/workflows/deploy.yml` | merge to `main`, or manual dispatch |
| Image roll | `scripts/roll_image.sh` | called by CD; also `make deploy IMAGE_TAG=…` |
| Provisioning | `personal-infra/context/deploy/deploy.sh` | by hand, when config/infra changes |

## The shared-droplet constraint

The MCP runs on the **slskd droplet** — one box, two unrelated stacks:

| | slskd | personal-context |
|---|---|---|
| compose | `/etc/slskd/docker-compose.yml` | `/opt/personal-context/docker-compose.yml` |
| containers | `slskd`, `rclone-sync` | `personal-context-mcp` |
| state | volume `slskd_app` → R2 | none (all in S3) |

Co-hosting is deliberate — it keeps the marginal cost at $0 (see
`personal-infra/context/README.md` for the cost math). The price is that an
automated deploy runs on a host where something else you care about is living.
`roll_image.sh` is written so it *cannot* reach slskd:

- every compose call is pinned to `-p personal-context` and the `mcp` service
- it never prunes images, touches volumes, or restarts the docker daemon
- the only file it writes is one line of `/opt/personal-context/.env`

**Keep those invariants** when editing it. The genuinely shared resource is RAM
(1GB, hence the swapfile); if it ever gets tight,
`docker compose -f /etc/slskd/docker-compose.yml stop` frees slskd's share
without losing the `slskd_app` volume.

## Branch protection: deliberately not used

This repo is **private on a Free plan**, where both the branch-protection and
ruleset APIs answer `403 Upgrade to GitHub Pro or make this repository public`.
Going public or paying for Pro was considered and **declined** (2026-08-05) — for
a single-maintainer personal project the discipline is worth more than the
enforcement.

So "no direct merge to main" lives entirely in a **pre-push hook**. Install it
once per clone:

```bash
make hooks    # sets core.hooksPath -> .githooks
```

Be honest about what this is: `git push --no-verify` bypasses it, and a clone
that never ran `make hooks` has no guard at all. It stops habit, not intent.
Nothing else prevents a direct push to `main` — and since CD triggers on push to
`main`, a direct push deploys straight to the droplet without ever running the
PR gate.

To remove it: `git config --unset core.hooksPath`.

If the repo ever goes public or moves to Pro, this becomes real with:

```bash
gh api -X PUT repos/PBenavides/personal-context-mcp/branches/main/protection \
  -F required_pull_request_reviews.required_approving_review_count=0 \
  -F 'required_status_checks.contexts[]=verify (typecheck, lint, test, smoke)' \
  -F 'required_status_checks.contexts[]=docker build (linux/amd64)' \
  -F required_status_checks.strict=true \
  -F enforce_admins=false -F restrictions=null
```

## One-time setup

Do all of this **before merging the first PR** — the deploy job runs on that
merge and will fail on a missing secret.

What the runner ends up holding:

| name | kind | what it is |
|---|---|---|
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | secret | CI IAM user; ECR push on `personal-context-mcp` only |
| `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET` | secret | Tailscale OAuth client, scope `auth_keys`, tag `tag:ci` |
| `DROPLET_SSH_KEY` | secret | private half of a deploy keypair in the droplet's `authorized_keys` |
| `MCP_SMOKE_BEARER_TOKEN` | secret | copy of SSM `/personal-context/mcp-bearer-token`, for the post-deploy smoke |
| `DROPLET_HOST` | variable | `100.118.218.44` (tailnet IP) — not a secret, just config |

### 1. Apply the Terraform

Creates the CI IAM user + its key, and publishes the droplet's own AWS key to
SSM so `deploy.sh` stops depending on the local `.tfstate`.

**Also fixes a latent break:** `deploy.sh` reads `/personal-context/google-*`,
but those three parameters were declared in `main.tf` and never applied. They
don't exist in AWS, so the script aborts at that line under `set -e`.

```bash
# 8 to add (3 CI resources, 2 SSM key params, 3 google-* placeholders),
# 2 tag updates, 0 destroyed.
cd personal-infra/context && terraform apply
```

### 2. AWS credentials + host config for the runner

```bash
cd personal-infra/context

# The CI user's key — lets the workflow log in to ECR and push the image.
# Read straight out of the state you just applied, never copy-pasted by hand.
gh secret set AWS_ACCESS_KEY_ID     -R PBenavides/personal-context-mcp -b "$(terraform output -raw ci_access_key_id)"
gh secret set AWS_SECRET_ACCESS_KEY -R PBenavides/personal-context-mcp -b "$(terraform output -raw ci_secret_access_key)"

# Where the deploy SSHes to. A variable, not a secret: it's a tailnet address,
# useless without tailnet membership, and it shows up readable in the run logs.
gh variable set DROPLET_HOST -R PBenavides/personal-context-mcp -b "100.118.218.44"

# The bearer token the post-deploy smoke authenticates with. Same value the
# running MCP checks against, so it must come from SSM rather than be invented.
gh secret set MCP_SMOKE_BEARER_TOKEN -R PBenavides/personal-context-mcp \
  -b "$(aws ssm get-parameter --profile personal --region us-east-1 \
        --name /personal-context/mcp-bearer-token --with-decryption \
        --query Parameter.Value --output text)"
```

### 3. Tailscale access for the runner

The droplet has no public SSH, so the runner joins the tailnet as an ephemeral
`tag:ci` node that is destroyed when the job ends — no device to prune later.

This step is **done in the admin console at <https://login.tailscale.com>**.
There is no way around it: creating an OAuth client (or an auth key) is a console
operation, and the API that could do it needs a key you'd get from the console
anyway.

**Order matters** — the tag must exist in the policy before a client can carry it.

#### 3a. Declare the tag (Access controls)

Edit the tailnet policy file. `tagOwners` is the only required change — it is
what makes `tag:ci` selectable in the next step:

```jsonc
"tagOwners": {
  // Who may mint nodes with this tag. Ephemeral CI runners, nothing else.
  "tag:ci": ["autogroup:admin"],
},
```

**Network access needs nothing extra** on the default policy: this tailnet's
`grants` is still the allow-all `{"src": ["*"], "dst": ["*"], "ip": ["*"]}`,
and `*` covers tagged devices. Only if you later restrict `grants` do you need
to grant the runner its two ports explicitly — 22 for the deploy, 8090 for the
smoke:

```jsonc
"grants": [
  // Deliberately does NOT include slskd's web UI on 5030.
  { "src": ["tag:ci"], "dst": ["100.118.218.44"], "ip": ["22", "8090"] },
],
```

Save. If the tag is rejected, the policy file has a syntax error — fix it before
continuing, or step 3b won't offer the tag. (The editor is HuJSON: trailing
commas are required, not forbidden.)

#### 3b. Generate the OAuth client (Settings → OAuth clients → Generate)

- **Scope:** `auth_keys` — **Write**. The action uses it to mint a one-off
  ephemeral auth key per run; read alone is not enough.
- **Tag:** `tag:ci` (it appears only after 3a is saved).

The client secret is displayed **once**. Copy both halves before closing the
dialog.

#### 3c. Store both halves

Each command waits for you to paste the value, then press Enter. Run them only
after 3b — that's what produces the values.

```bash
# Paste the Client ID when prompted (starts with a k…).
gh secret set TS_OAUTH_CLIENT_ID -R PBenavides/personal-context-mcp

# Paste the Client secret when prompted (starts with tskey-client-…).
gh secret set TS_OAUTH_SECRET    -R PBenavides/personal-context-mcp
```

Lost the secret? You can't retrieve it — delete the client and redo 3b.

### 4. Deploy keypair for the droplet

#### 4a. Prerequisite: Tailscale SSH must be off on the droplet

cloud-init brought the droplet up with `tailscale up --ssh`, which makes
**tailscaled answer port 22 for tailnet connections instead of sshd**. When that
is on, `authorized_keys` is bypassed entirely and access is decided by the `ssh`
block of the tailnet policy — where a `tag:ci` runner is rejected twice over:
`src: ["autogroup:member"]` doesn't match a tagged node, and `action: "check"`
demands an interactive browser approval no CI job can complete.

Tailscale SSH also can't be fixed by policy alone here: per the policy-file
reference, an `ssh` rule whose `src` is a tag may only use a **tag** as `dst`
(`autogroup:self` and named users are both invalid for a tagged source). The
droplet is untagged, and tagging it would transfer node ownership away from the
user account and break the existing `autogroup:self` rule.

So turn it off and let sshd serve port 22:

```bash
# Verify first: this must print a key you hold locally (ssh-keygen -lf ~/.ssh/id_ed25519.pub).
ssh root@100.118.218.44 'ssh-keygen -lf ~/.ssh/authorized_keys'

# Hand port 22 back to sshd, which is already listening.
ssh root@100.118.218.44 'tailscale set --ssh=false'

# Confirm: should now report OpenSSH, not Tailscale.
ssh -v root@100.118.218.44 exit 2>&1 | grep "remote software version"
```

The `ssh` block in the tailnet policy becomes dead config after this — harmless,
leave it. To reverse: `tailscale set --ssh=true`.

#### 4b. The keypair

A dedicated keypair, so CI's access can be revoked without touching your own.

```bash
# Generate a throwaway keypair locally (-N '' = no passphrase; CI can't type one).
ssh-keygen -t ed25519 -f /tmp/ci_deploy -N '' -C 'github-actions'

# Authorize the PUBLIC half on the droplet. Appends — your own key stays put.
ssh root@100.118.218.44 "cat >> ~/.ssh/authorized_keys" < /tmp/ci_deploy.pub

# Hand the PRIVATE half to GitHub (stdin, so it never lands in shell history).
gh secret set DROPLET_SSH_KEY -R PBenavides/personal-context-mcp < /tmp/ci_deploy

# Neither half should outlive this step on your laptop.
rm /tmp/ci_deploy /tmp/ci_deploy.pub
```

To revoke later: delete that line from the droplet's `~/.ssh/authorized_keys`.

### 5. Install the hook

```bash
# The only thing keeping a direct push off main. Once per clone.
make hooks
```

## Day-to-day

```bash
git switch -c feat/thing
# … work; `make verify` locally mirrors CI exactly …
git push -u origin HEAD
gh pr create --fill
# CI goes green, merge → deploy happens on its own
```

**Rollback.** Every merge is tagged `sha-<commit>` in ECR, so rolling back is
deploying an older tag — Actions → Deploy → *Run workflow* with a tag, or:

```bash
make deploy IMAGE_TAG=sha-abc1234
```

A deploy that fails `/ready` rolls itself back automatically and prints the
failed container's logs in the Action.

**Changing configuration** (a new env var, a secret, the pipeline image, the
systemd timer) is *not* covered by CD. Put the value in SSM, then run the
provisioner by hand:

```bash
bash personal-infra/context/deploy/deploy.sh
```

## Not automated on purpose

- **`terraform apply`** — mutates live IAM. Human-run.
- **`deploy.sh`** — writes the full `.env` and systemd units to a shared host.
- **`context-pipeline`** — no GitHub remote yet; still laptop-built. Same
  treatment once it's pushed.
