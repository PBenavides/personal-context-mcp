.PHONY: dependencies format lint test typecheck build smoke verify
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
