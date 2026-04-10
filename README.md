# Bashful

**Bashful** gives your CLI tools a REST API — no code required.

The name is a double meaning: it wraps **bash**ful tools (tools that only speak shell), and it does so quietly, without you having to write a single line of server code. You hand it a command name, and Bashful reads the `--help` output, figures out the flags, and instantly serves a REST API and a browser UI you can poke at.

Think of it as a shy CLI tool finding its voice over HTTP.

![bashful_infographics-v1](https://github.com/user-attachments/assets/f2e9d659-0e9d-4d84-ba27-b50ca399f397)


---

## What it does

Most command-line tools are only accessible from a terminal. Bashful bridges that gap:

1. **Reads** the tool's `--help` output at startup.
2. **Parses** every flag — short (`-s`), long (`--silent`), typed (`--output <file>`), and boolean — into a JSON schema.
3. **Serves** a local REST API where each JSON key maps back to a CLI flag.
4. **Executes** the real command when you POST to the endpoint, streaming the output back as plain text.
5. **Shows** a browser UI (Swagger-style) auto-generated from the parsed schema so you can fill in flags and run commands without touching a terminal.

No config files. No code. Starts in milliseconds.

---

## Prerequisites

- [Bun](https://bun.sh/) v1.0+

Install on Linux/macOS:
```bash
curl -fsSL https://bun.sh/install | bash
```

Install on Windows:
```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

---

## Quick start

```bash
bun install
bun run bashful.ts curl
```

Then open `http://localhost:3000` in your browser, or:

```bash
# Get the parsed flag schema
curl http://localhost:3000/curl/schema

# Execute curl via HTTP
curl -X POST http://localhost:3000/curl \
  -H "Content-Type: application/json" \
  -d '{"silent": true, "output": "example.html", "_args": ["http://example.com"]}'
```

That POST translates to: `curl --silent --output example.html http://example.com`

---

## Multiple commands

Use `\|` to wrap several tools at once. Each gets its own endpoint and a tab in the UI:

```bash
bun run bashful.ts curl \| wget \| ping
```

Endpoints created:
- `POST /curl` — execute curl
- `POST /wget` — execute wget
- `POST /ping` — execute ping
- `GET /<cmd>/schema` — parsed flag schema for each

---

## Invocation modes

**Direct mode** — Bashful appends `--help` automatically:
```bash
bun run bashful.ts curl
```

**Pipe mode** — provide the exact help command yourself (useful when `--help` fails or outputs to stderr):
```bash
bun run bashful.ts curl --help
bun run bashful.ts git log --help
```

Both modes can be mixed when using `\|`:
```bash
bun run bashful.ts curl --help \| wget
```

---

## Payload conventions (`POST /<command>`)

| Payload key | CLI result |
|---|---|
| `_args: ["http://example.com"]` | positional args, prepended before flags |
| `"silent": true` | `--silent` |
| `"output": "file.html"` | `--output file.html` |
| `"v": true` | `-v` (single-char keys become short flags) |
| `"silent": false` | *(omitted)* |

---

## Debug mode

Pass `--debug` anywhere before the command to log startup time, parsed flag counts, and each execution:

```bash
bun run bashful.ts --debug curl \| wget
```

---

## Running tests

```bash
bun test
```

Tests cover the three pure functions at the core of Bashful: `splitSegments` (arg parsing), `parseSchema` (regex-based help text parsing), and `buildCLIArgs` (payload → CLI translation).

---

## Architecture

Everything lives in a single file: `bashful.ts`.

- **`splitSegments(args)`** — splits CLI args on `|` into per-command segments.
- **`parseSchema(helpText)`** — the "Bashful Regex" extracts short flags, long flags, value types (`<val>`, `[val]`, `ALL_CAPS`), and descriptions into a keyed schema object.
- **`buildCLIArgs(payload, schema)`** — translates a JSON payload back into a flat CLI argument array.
- **Server** — `Bun.serve` on port 3000. Routes: `GET /` (UI), `GET /<cmd>/schema`, `POST /<cmd>`.
- **Execution** — `Bun.spawn` runs the real command and streams stdout directly as the HTTP response.
