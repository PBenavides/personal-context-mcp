.PHONY: bootstrap dependencies format lint test build check
TAXFIX_MAKEFILE_VERSION=1
APPLICATION_NAME=txf-context-mcp

bootstrap:
	@echo "This command is currently a Noop."

dependencies:
	@npm ci

format:
	@npm run format

lint:
	@npm run lint

test:
	@npm test

IMAGE_URL=$(if $(value DOCKER_IMAGE_URL),$(value DOCKER_IMAGE_URL),$(APPLICATION_NAME))
IMAGE_TAG=$(if $(value DOCKER_IMAGE_TAG),$(value DOCKER_IMAGE_TAG),"latest")

build:
	@DOCKER_BUILDKIT=1 docker build -t $(IMAGE_URL):$(IMAGE_TAG) \
	--progress=plain .

check: dependencies lint test build
