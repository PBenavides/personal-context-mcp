.PHONY: dependencies format lint test typecheck build smoke verify release
APPLICATION_NAME=personal-context-mcp

dependencies:
	@npm ci

format:
	@npm run format

lint:
	@npm run lint

typecheck:
	@npm run typecheck

test:
	@npm test

IMAGE_URL=$(if $(value DOCKER_IMAGE_URL),$(value DOCKER_IMAGE_URL),$(APPLICATION_NAME))
IMAGE_TAG=$(if $(value DOCKER_IMAGE_TAG),$(value DOCKER_IMAGE_TAG),"latest")

build:
	@DOCKER_BUILDKIT=1 docker build -t $(IMAGE_URL):$(IMAGE_TAG) \
	--progress=plain .

# Build for the x86_64 droplet and push to ECR (deploy happens via
# personal-infra/context/deploy/deploy.sh).
REGION=us-east-1
AWS_PROFILE?=personal
ECR_REPO=$(shell aws ecr describe-repositories --profile $(AWS_PROFILE) --region $(REGION) \
  --repository-names personal-context-mcp --query 'repositories[0].repositoryUri' --output text)

release:
	@aws ecr get-login-password --profile $(AWS_PROFILE) --region $(REGION) | \
		docker login --username AWS --password-stdin $$(echo $(ECR_REPO) | cut -d/ -f1)
	@docker build --platform linux/amd64 -t $(ECR_REPO):latest .
	@docker push $(ECR_REPO):latest
	@echo "released $(ECR_REPO):latest"

# Streamable-HTTP protocol smoke test against the fixture corpus (no credentials).
smoke:
	@bash scripts/mcp_smoke.sh

# The Workstream C verification gates: no taxfix leftovers, types, lint, unit
# tests, and the real-protocol smoke test.
verify: typecheck lint test smoke
	@if grep -riq taxfix . --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git --exclude=Makefile; then \
		echo "VERIFY FAIL: 'taxfix' still referenced:"; \
		grep -ril taxfix . --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git --exclude=Makefile; \
		exit 1; \
	fi
	@echo "verify: ALL GREEN"
