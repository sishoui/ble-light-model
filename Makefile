# make test 只做一行转发到 `npm test`（test-strategy.md §2），不是第二个真源。
.PHONY: test
test:
	npm test