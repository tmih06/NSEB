
.PHONY: help sync-sources install dev start serve serve-down test clean

SEB_LINUX_DIR := seb-linux
SEB_MAC_DIR := seb-mac
SEB_SERVER_DIR := seb-server
SEB_WIN_DIR := seb-win-refactoring

SEB_MAC_REPO := https://github.com/SafeExamBrowser/seb-mac.git
SEB_SERVER_REPO := https://github.com/SafeExamBrowser/seb-server.git
SEB_WIN_REPO := https://github.com/SafeExamBrowser/seb-win-refactoring.git

help:
	@printf '%s\n' \
		'Available targets:' \
		'  make sync-sources - clone sibling SEB source trees if missing' \
		'  make install  - install seb-linux dependencies' \
		'  make dev      - install deps and launch seb-linux (hot reload)' \
		'  make start    - launch seb-linux from the root project' \
		'  make serve    - rebuild and boot a fresh seb-server local test exam stack' \
		'  make serve-down - stop and remove the seb-server local test stack' \
		'  make test     - run seb-linux tests' \
		'  make clean    - remove seb-linux node_modules'

sync-sources:
	@test -d $(SEB_LINUX_DIR) || { printf '%s\n' 'Missing seb-linux in project root.'; exit 1; }
	@test -d $(SEB_MAC_DIR) || git clone --depth 1 $(SEB_MAC_REPO) $(SEB_MAC_DIR)
	@test -d $(SEB_SERVER_DIR) || git clone --depth 1 $(SEB_SERVER_REPO) $(SEB_SERVER_DIR)
	@test -d $(SEB_WIN_DIR) || git clone --depth 1 $(SEB_WIN_REPO) $(SEB_WIN_DIR)

install: sync-sources
	npm --prefix $(SEB_LINUX_DIR) install

dev: install
	npm --prefix $(SEB_LINUX_DIR) run dev

start:
	npm --prefix $(SEB_LINUX_DIR) start

serve:
	./scripts/serve-local-test.sh

serve-down:
	docker compose -f $(SEB_SERVER_DIR)/local-test/docker-compose.yml down -v --remove-orphans

test:
	node $(SEB_LINUX_DIR)/test/test.js

clean:
	rm -rf $(SEB_LINUX_DIR)/node_modules
