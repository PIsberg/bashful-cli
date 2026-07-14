# Usage

How to run Bashful, call its endpoints, and restrict what it will execute.

- [Invocation](#invocation)
- [Endpoints](#endpoints)
- [Payload conventions](#payload-conventions)
- [Access control](#access-control)
- [Environment variables](#environment-variables)
- [Debug mode](#debug-mode)

---

## Invocation

```bash
bun run bashful.ts [--debug] [--config <file>] <command> [args...] [\| <command2> ...]
```

**Direct mode** — Bashful discovers the help text itself. It tries `--help`, then `-h`, `-?`, and `/?`, stopping at the first one that yields a parseable schema:

```bash
bun run bashful.ts curl
```

**Pipe mode** — you supply the exact help command. Use this when the tool needs a subcommand, or when `--help` alone doesn't produce usable output:

```bash
bun run bashful.ts curl --help
bun run bashful.ts git log --help
```

**Multiple commands** — separate them with `\|`. Each segment becomes its own endpoint and its own tab in the UI. The pipe is escaped because an unescaped `|` would be intercepted by your shell:

```bash
bun run bashful.ts curl \| wget \| ping
```

Modes can be mixed across segments: `bun run bashful.ts curl --help \| wget`.

The server then listens on <http://localhost:3000>.

---

## Endpoints

For each wrapped command `<cmd>`:

| Route | Purpose |
|---|---|
| `GET /` (also `/docs`, `/ui`) | The auto-generated browser UI — one tab per command. |
| `GET /<cmd>/schema` | The parsed flag schema as JSON. Reflects the access-control policy: forbidden flags are not listed. |
| `POST /<cmd>` | Execute the command. Flags come from the JSON body. |
| `GET /<cmd>?flag=value` | Execute the command. Flags come from the query string. Convenient for a browser or `curl`; identical semantics to `POST`. |

Responses stream the command's output as `text/plain`, with **stdout and stderr merged** — many CLIs write their real output or their diagnostics to stderr, so both are returned. The exit code is not currently surfaced; a failing command shows up as its error text in the body.

A request blocked by the policy returns `403` with `{"error": "Forbidden", "reason": "..."}`. An unknown path returns `404` listing the available endpoints.

---

## Payload conventions

The JSON body (or query string) is translated back into CLI arguments. Keys are **flag names without dashes**.

| Payload | CLI result |
|---|---|
| `{"_args": ["http://example.com"]}` | positional args, placed **before** all flags |
| `{"_args": "http://example.com"}` | same — a bare string is accepted |
| `{"silent": true}` | `--silent` |
| `{"silent": false}` | *(omitted entirely)* |
| `{"output": "file.html"}` | `--output file.html` |
| `{"v": true}` | `-v` — unknown single-char keys become short flags |
| `{"x": "GET"}` | `-x GET` |

A flag known to the schema as a boolean is emitted as a bare flag; anything else is emitted as `--flag value`. Keys that aren't in the schema still work — they fall back to `--long` or `-s` form based on key length.

```bash
curl -X POST http://localhost:3000/curl \
  -H "Content-Type: application/json" \
  -d '{"silent": true, "output": "example.html", "_args": ["http://example.com"]}'
# → curl --silent --output example.html http://example.com
```

> [!NOTE]
> Values are passed to `Bun.spawn` as a plain argument array, not through a shell, so there is no shell metacharacter expansion between Bashful and the command.

---

## Access control

Bashful executes real commands. An optional JSON policy restricts **which commands** it will wrap and **which flags, and combinations of flags**, each one accepts. With no config file present, nothing is restricted.

Config is loaded from, in order:

1. `--config <file>` (or `--config=<file>`)
2. `$BASHFUL_CONFIG`
3. `./bashful.config.json`, if it happens to exist

A `--config` path that doesn't exist is an error and Bashful exits; the implicit `./bashful.config.json` is simply skipped when absent.

```json
{
  "mode": "blacklist",
  "commands": {
    "allow": ["curl", "wget"],
    "deny": ["rm", "sudo"]
  },
  "flags": {
    "*":    { "deny": ["config"] },
    "curl": {
      "allow": ["_args", "silent", "output"],
      "deny": ["upload-file"],
      "denyCombinations": [["output", "proxy"]],
      "allowCombinations": [["_args", "silent"], ["_args", "output"]]
    }
  }
}
```

| Key | Meaning |
|---|---|
| `mode` | `"blacklist"` (default) — allow unless denied. `"whitelist"` — deny unless allowed. |
| `commands.allow` / `.deny` | Which commands may be wrapped at all. |
| `flags.<cmd>` | Flag rules for one command. The `"*"` key applies to every command and is merged with the command's own rules. |
| `flags.<cmd>.allow` / `.deny` | Individual flags. Naming an `allow` list whitelists that command's flags even in blacklist mode. |
| `flags.<cmd>.denyCombinations` | Flag sets. Rejected if a request uses **all** flags of any listed set; each flag remains fine on its own. |
| `flags.<cmd>.allowCombinations` | Flag sets. Rejected unless every flag a request uses fits inside **one** listed set. |

Rules name **payload keys**, not CLI spellings: write `output`, not `--output`. Positional arguments are governed under the name `_args`. `"*"` inside any list means "everything". **Deny always beats allow.** A flag set to `false` builds to nothing, so the rules ignore it.

The two combination forms answer different questions. `denyCombinations` says *"these must never appear together"* — useful for pairs that are individually harmless but dangerous combined. `allowCombinations` says *"only these shapes of request are valid"* — a request's flags must all be contained in a single listed set, so two flags that are each legal but belong to different sets are rejected together.

### How it is enforced

- **At startup** — wrapping a denied command is refused and Bashful exits non-zero.
- **At request time** — a blocked payload gets `403` and the command never spawns. This covers `POST` bodies and `GET` query params, including keys that never appeared in the parsed schema.
- **In the schema and UI** — `GET /<cmd>/schema` only advertises permitted flags, so the generated form can't offer something that would be rejected. Combination rules can't be expressed in a form, so those are enforced on the request.

> [!WARNING]
> This gates the flags Bashful passes to a command; it does **not** sandbox the command. A wrapped tool that can read files or reach the network can still do so within the flags you permit. Bashful binds to `127.0.0.1` by default for the same reason — see below before changing that.

Start from [`bashful.config.example.json`](../bashful.config.example.json).

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on. |
| `HOST` | `127.0.0.1` | Interface to bind. |
| `BASHFUL_CONFIG` | *(unset)* | Path to the policy file, if not passed via `--config`. |

`HOST` defaults to loopback deliberately: this server runs arbitrary CLI commands, so binding it to `0.0.0.0` exposes command execution to anyone who can reach the port. Only widen it behind a policy you trust and a network you control.

---

## Debug mode

```bash
bun run bashful.ts --debug curl \| wget
```

Logs startup time, the config file loaded and its mode, the number of flags parsed per command, every command executed, and every request blocked by the policy (with the reason). `--debug` can appear anywhere in the arguments.
