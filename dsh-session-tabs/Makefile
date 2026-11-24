.PHONY: help check test

help:
	@printf '%s\n' 'check  Check the plain client and Host entry syntax' 'test   Run sidebar auto-hide regression tests (uses existing sibling chat-bubbles test dependencies)'

check:
	node --check client.js
	node --check index.js

test: check
	node --test test/sidebar-autohide.test.mjs
