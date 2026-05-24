#!/usr/bin/env bash
# Replayed by asciinema to produce docs/demo.gif.
# Run from: tools/demo/ or repository root.

GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

step() { echo -e "${DIM}# $*${RESET}"; sleep 0.5; }
cmd()  {
    echo -e "${GREEN}\$${RESET} ${BOLD}$*${RESET}"
    sleep 0.4
    eval "$*"
    echo ""
    sleep 1.0
}

clear
echo -e "${BOLD}Bashful CLI-to-REST auto-wrapper${RESET} — instantly give CLI tools a REST API"
echo ""
sleep 0.8

step "1. Wrap curl using bashful.ts"
cmd "bun run bashful.ts curl &"
sleep 2

step "2. Look at the parsed flag schema that was automatically generated"
cmd "curl -s http://localhost:3000/curl/schema | jq 'with_entries(.value |= {shortFlag, longFlag, type}) | to_entries | .[0:4]'"
sleep 0.3

step "3. Execute curl via the REST API with a JSON payload!"
cmd "curl -X POST http://localhost:3000/curl -H 'Content-Type: application/json' -d '{\"silent\": true, \"_args\": [\"https://icanhazip.com\"]}'"
sleep 0.3

step "4. Stop the bashful server"
cmd "kill %1"

echo -e "${GREEN}✓ Instantly served REST API and Swagger UI with zero config!${RESET}"
sleep 2
