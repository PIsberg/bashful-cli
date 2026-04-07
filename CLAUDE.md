# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install                                    # Install dependencies
bun run bashful.ts <command>                   # Wrap a command using --help
bun run bashful.ts pipe <command> --help       # Explicit help text piping
bun run bashful.ts --debug pipe curl --help    # Run with debug logging
bun run start                                  # Alias: wraps curl via pipe mode
```

There are no tests in this project.

## Architecture

The entire application lives in a single file: `bashful.ts`.

**Startup flow:**

1. **Ingestion** — Executes `<command> --help` (or `<explicit command>` in `pipe` mode) via `Bun.spawnSync` and captures stdout+stderr.
2. **Schema synthesis** — Parses the help text with a heuristic regex (the "Bashful Regex") that extracts short flags (`-x`), long flags (`--foo`), argument types (`<val>`, `[val]`, or `ALL_CAPS`), and descriptions into a `schema` object keyed by flag name.
3. **Server** — Spins up a `Bun.serve` HTTP server on port 3000 with three routes:
   - `GET /` (also `/docs`, `/ui`) — Returns a self-contained HTML page (the Swagger-like UI) with the schema baked in via template literal.
   - `GET /<command>/schema` — Returns the parsed schema as JSON.
   - `POST /<command>` or `GET /<command>` — Translates the JSON body (or query params) back into CLI arguments and executes the command with `Bun.spawn`, streaming stdout as the response.

**Payload conventions (POST `/<command>`):**
- `_args`: positional arguments (string or string array)
- Boolean flags: `{ "silent": true }` → `--silent`
- Value flags: `{ "output": "file.html" }` → `--output file.html`
- Unknown single-char keys fall back to `-x` short-flag style.

**Two invocation modes:**
- Direct: `bashful.ts curl` — runs `curl --help` internally.
- Pipe: `bashful.ts pipe curl --help` — runs the full provided command to get help text (useful when `--help` alone fails or outputs to stderr).

**`--debug` flag:** logs startup time, number of parsed flags, and each execution command.
