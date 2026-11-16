.PHONY: help deps check test

help:
	@printf '%s\n' 'deps  Install locked test-only dependencies' 'check Check plugin syntax (plain JS; no bundle build needed)' 'test  Run syntax and DOM regression tests'

deps:
	npm ci --ignore-scripts

check:
	npm run check

test: check
	npm test
