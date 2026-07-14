# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install                                         # Install dependencies
bun run bashful.ts <command>                        # Wrap a command using --help
bun run bashful.ts curl \| wget                     # Multiple commands, one endpoint each
bun run bashful.ts curl --help \| wget --help       # Explicit help commands (pipe mode)
bun run bashful.ts --debug curl \| wget             # Run with debug logging
bun run bashful.ts --config policy.json curl        # Run with an access-control policy
bun run start                                       # Alias: wraps curl
```

```bash
bun test                                            # Run all tests
bun test -t "authorizeFlags"                        # Run one describe block / test by name
bunx tsc --noEmit                                   # Typecheck (tsconfig is noEmit; there is no build step)
```

CI (`.github/workflows/test.yml`) runs `bun install` + `bun test` on push/PR to `main`. Lint is not wired into `package.json` — ESLint, gitleaks, and whitespace fixers run via `.pre-commit-config.yaml`.

**Env vars:** `PORT` (default `3000`), `HOST` (default `127.0.0.1`), `BASHFUL_CONFIG` (policy file path).

## Docs

`docs/usage.md` (invocation, endpoints, payloads, access control), `docs/architecture.md` (schema synthesis, enforcement layering, invariants), `docs/testing.md` (suite layout, integration-test mechanics). Keep them in sync when changing behaviour they describe.

## Architecture

The entire application lives in a single file: `bashful.ts`.

**Startup flow:**

1. **Ingestion** — Executes `<command> --help` (or `<explicit command>` in `pipe` mode) via `Bun.spawnSync` and captures stdout+stderr.
2. **Schema synthesis** — Parses the help text with a heuristic regex (the "Bashful Regex") that extracts short flags (`-x`), long flags (`--foo`), argument types (`<val>`, `[val]`, or `ALL_CAPS`), and descriptions into a `schema` object keyed by flag name.
3. **Policy** — Loads an optional JSON config (`--config <file>`, `$BASHFUL_CONFIG`, or `./bashful.config.json`) and refuses to wrap any denied command. Denied flags are stripped from the served schema so the UI can't offer them.
4. **Server** — Spins up a `Bun.serve` HTTP server on port 3000 with three routes:
   - `GET /` (also `/docs`, `/ui`) — Returns a self-contained HTML page (the Swagger-like UI) with the schema baked in via template literal.
   - `GET /<command>/schema` — Returns the parsed schema as JSON.
   - `POST /<command>` or `GET /<command>` — Checks the payload against the policy (403 with a `reason` if blocked), then translates the JSON body (or query params) back into CLI arguments and executes the command with `Bun.spawn`, streaming stdout as the response.

**Payload conventions (POST `/<command>`):**
- `_args`: positional arguments (string or string array)
- Boolean flags: `{ "silent": true }` → `--silent`
- Value flags: `{ "output": "file.html" }` → `--output file.html`
- Unknown single-char keys fall back to `-x` short-flag style.

**Multiple commands:** Separate commands with `\|` (escaped pipe character). Each segment becomes its own endpoint and tab in the UI.
- `bashful.ts curl \| wget` — two endpoints: `/curl` and `/wget`
- `bashful.ts curl --help \| wget --help` — pipe mode per segment: runs the full command as-is to get help text (useful when `--help` alone fails or outputs to stderr)

**Access control:** an optional config file gates both commands and flags. `mode` is `blacklist` (allow unless denied) or `whitelist` (deny unless allowed). `commands.allow`/`deny` gate whole commands; `flags.<cmd>.allow`/`deny` gate individual flags; `flags.<cmd>.denyCombinations`/`allowCombinations` gate *sets* of flags used together. The `"*"` key under `flags` applies to every command; `"*"` inside a list means "everything". Rules name payload keys (`output`, `_args`), not CLI spellings (`--output`). Deny always beats allow. See `bashful.config.example.json` and the README for details.

**`--debug` flag:** logs startup time, number of parsed flags, config load, blocked requests, and each execution command.

## Conventions

**Pure core, imperative shell.** Everything above the `// ── Entry point ──` divider in `bashful.ts` is exported pure functions (`splitSegments`, `parseSchema`, `buildCLIArgs`, `normalizeConfig`, `authorizeCommand`, `authorizeFlags`, `filterSchema`, …); everything below runs under `if (import.meta.main)`. Tests import the module directly, so new logic belongs above the divider — anything below it only runs as a process and can't be unit-tested.

**Invariants that are easy to undo accidentally:**
- The server binds to `127.0.0.1` by default. It executes arbitrary CLI commands, so it must not listen on `0.0.0.0` unless the operator deliberately sets `HOST`.
- **Browser hardening works only as a set** — no CORS headers unless `--allow-origin` names one; exec requires `POST` + `Content-Type: application/json` (this is what forces a preflight, which then fails); the `Host` header must be loopback (defeats DNS rebinding); `GET` exec is off unless `--allow-get`. Loosening any single one re-opens command execution to any web page the user visits. See `docs/architecture.md#invariants`.
- The exec route merges stdout **and** stderr into one stream. Many CLIs write their real output or diagnostics to stderr; returning stdout alone silently yields empty responses.

**Tests** (`bashful.test.ts`) are unit tests plus integration tests that spawn the real server via `bun run ./bashful.ts` on fixed ports (3005–3009). New integration suites need their own unused port, and policy fixtures are written to `tmpdir()` and passed with `--config`.

**Windows:** `safeSpawn` retries a failed `ENOENT` spawn through `cmd /c`, which is how shell builtins and `.cmd` shims resolve. The `\|` command separator is escaped because an unescaped `|` would be consumed by the shell.
