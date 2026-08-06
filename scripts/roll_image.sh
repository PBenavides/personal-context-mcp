#!/usr/bin/env bash
# Roll the personal-context-mcp container to a new image tag, with rollback.
#
# This is the CD half of the deploy story and it is deliberately NARROW. Full
# provisioning — rendering .env from SSM, the swapfile, the pipeline image and
# its systemd timer — stays in personal-infra/context/deploy/deploy.sh, run by a
# human when infra or configuration changes. This script only ever swaps the
# MCP's image tag and restarts that one service.
#
# Why the narrowness matters: the droplet is SHARED with slskd (containers
# `slskd` + `rclone-sync`, compose project at /etc/slskd/, volume slskd_app).
# The invariants below keep an automated deploy from ever reaching them:
#
#   * every compose call is pinned to `-p personal-context` and the `mcp` service
#   * nothing here prunes images, touches volumes, or restarts the docker daemon
#   * the only file written is /opt/personal-context/.env, one line of it
#
# Usage (from a host with tailnet access + AWS creds that can read ECR):
#   IMAGE_TAG=sha-abc1234 ./scripts/roll_image.sh
#   IMAGE_TAG=latest DROPLET=root@100.118.218.44 ./scripts/roll_image.sh
set -euo pipefail

DROPLET="${DROPLET:-root@100.118.218.44}"
REGION="${AWS_REGION:-us-east-1}"
REMOTE_DIR=/opt/personal-context
IMAGE_TAG="${IMAGE_TAG:?IMAGE_TAG is required (e.g. sha-abc1234)}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"

# IMAGE_TAG is interpolated into a remote shell command below (sed + docker
# pull over ssh), so validate it HERE rather than in the caller — `make deploy`
# and a bare ./scripts/roll_image.sh must be as safe as the workflow. Anything
# outside the tag shapes we actually mint is refused, which also catches the
# boring case of a typo'd tag containing a quote or pipe mangling the sed.
if ! printf '%s' "$IMAGE_TAG" | grep -Eq '^(latest|sha-[0-9a-f]{7,40})$'; then
  echo "!! refusing to deploy unrecognised tag: ${IMAGE_TAG}" >&2
  echo "   expected 'latest' or 'sha-<commit>'" >&2
  exit 1
fi

# `deploy.sh` takes AWS_PROFILE on the laptop; CI supplies credentials via the
# environment instead. Support both without forcing a profile to exist.
aws_args=(--region "$REGION")
if [[ -n "${AWS_PROFILE:-}" ]]; then aws_args+=(--profile "$AWS_PROFILE"); fi

echo "==> resolving ECR repository"
ECR_REPO=$(aws ecr describe-repositories "${aws_args[@]}" \
  --repository-names personal-context-mcp \
  --query 'repositories[0].repositoryUri' --output text)
REGISTRY=${ECR_REPO%%/*}
NEW_IMAGE="${ECR_REPO}:${IMAGE_TAG}"
echo "    ${NEW_IMAGE}"

# Fail fast if the tag was never pushed, rather than discovering it mid-restart.
echo "==> verifying the tag exists in ECR"
aws ecr describe-images "${aws_args[@]}" \
  --repository-name personal-context-mcp \
  --image-ids "imageTag=${IMAGE_TAG}" >/dev/null

echo "==> reading the currently deployed image (rollback target)"
PREV_IMAGE=$(ssh "$DROPLET" "grep '^MCP_IMAGE=' ${REMOTE_DIR}/.env | cut -d= -f2-" || true)
if [[ -z "$PREV_IMAGE" ]]; then
  echo "!! no MCP_IMAGE in ${REMOTE_DIR}/.env — run personal-infra/context/deploy/deploy.sh first" >&2
  exit 1
fi
echo "    currently: ${PREV_IMAGE}"

# The droplet's own IAM key has no ECR permissions by design, so the registry
# login is materialized here and piped over SSH — exactly as deploy.sh does it.
echo "==> ECR login on the droplet + pull"
aws ecr get-login-password "${aws_args[@]}" |
  ssh "$DROPLET" "docker login --username AWS --password-stdin ${REGISTRY} >/dev/null && \
    docker pull -q ${NEW_IMAGE}"

# Rewrite exactly the MCP_IMAGE line. Every other value in .env (secrets rendered
# from SSM, the pipeline image, the tailnet IP) is left untouched.
echo "==> pointing .env at the new image and restarting the mcp service"
ssh "$DROPLET" "cd ${REMOTE_DIR} && \
  sed -i 's|^MCP_IMAGE=.*|MCP_IMAGE=${NEW_IMAGE}|' .env && \
  docker compose -p personal-context up -d mcp"

# /ready runs healthCheckAll() over the live connections (S3 corpus, vectors) and
# answers 503 until they all pass — a real readiness gate, not just "port open".
echo "==> waiting up to ${HEALTH_TIMEOUT}s for /ready"
if ssh "$DROPLET" "for i in \$(seq 1 ${HEALTH_TIMEOUT}); do
      if curl -sf -o /dev/null http://127.0.0.1:8090/ready; then echo ready; exit 0; fi
      sleep 1
    done
    exit 1"; then
  echo "==> deployed ${NEW_IMAGE}"
  exit 0
fi

# Capture the failure evidence BEFORE restarting, or the logs we print would be
# from the healthy rolled-back container instead of the broken one.
echo "!! /ready never came up. Logs from the failed image:" >&2
ssh "$DROPLET" "docker logs --tail 50 personal-context-mcp 2>&1" >&2 || true

echo "!! rolling back to ${PREV_IMAGE}" >&2
ssh "$DROPLET" "cd ${REMOTE_DIR} && \
  sed -i 's|^MCP_IMAGE=.*|MCP_IMAGE=${PREV_IMAGE}|' .env && \
  docker compose -p personal-context up -d mcp"
echo "!! rolled back to ${PREV_IMAGE}" >&2
exit 1
