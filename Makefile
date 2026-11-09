SHELL=/bin/bash
.DEFAULT_GOAL := test

.PHONY: install
install: ## Install dependencies (Yarn 1; npm can't fetch the git dependency)
	corepack yarn install --frozen-lockfile

.PHONY: test
test: ## Unit tests under Node 18, as CI runs them (set NODE18_DIR if not in ~/.local/node-18.1.0)
	scripts/test-node18.sh

.PHONY: build
build: ## Production build
	corepack yarn build
