# Build a linux/arm64 image and push it to your registry.
#   make release REGISTRY=registry.example.com
# or put `REGISTRY := registry.example.com` in local.mk (git-ignored).
-include local.mk
REGISTRY ?= $(error set REGISTRY, e.g. make release REGISTRY=registry.example.com)
IMAGE    = $(REGISTRY)/excalidraw-boards
TAG      ?= $(shell git rev-parse --short HEAD)
PLATFORM ?= linux/arm64

.PHONY: build push release run

build:
	docker buildx build --platform $(PLATFORM) --load -t $(IMAGE):$(TAG) -t $(IMAGE):latest .

push:
	docker push $(IMAGE):$(TAG)
	docker push $(IMAGE):latest

release: build push
	@echo "released $(IMAGE):$(TAG) (+ latest)"

# Try the image locally against ./data.
run:
	docker build -t excalidraw-boards . && docker run --rm -p 3779:3779 -v $(PWD)/data:/data excalidraw-boards
