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
bun run bashful.ts [--debug] [--config <file>] [--allow-get] [--allow-origin <origin>] <command> [args...] [\| <command2> ...]
```

Bashful's own options are consumed wherever they appear; everything else is treated as the wrapped command.

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
| `POST /<cmd>` | Execute the command. Flags come from the JSON body. Requires `Content-Type: application/json`. |
| `GET /<cmd>?flag=value` | Execute the command with flags from the query string. **Disabled by default** — see [Browser safety](#browser-safety). Enable with `--allow-get`. |

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
| `{"header": ["A: 1", "B: 2"]}` | `--header "A: 1" --header "B: 2"` — an array **repeats** the flag |
| `{"retry": 3}` | `--retry 3` — numbers are fine |
| `{"output": null}` | *(omitted)* |

A flag known to the schema as a boolean is emitted as a bare flag; anything else is emitted as `--flag value`. Keys that aren't in the schema still work — they fall back to `--long` or `-s` form based on key length.

**Repeatable flags** (`curl -H`, `docker -e`, …) are expressed as an array, which repeats the flag once per element rather than joining the values. On the `GET` route, repeating a query param does the same thing: `?header=A&header=B`.

Values must be strings, numbers, booleans, or arrays of those. An object has no sensible CLI spelling — rather than passing the command a literal `[object Object]`, Bashful rejects the request with `400`.

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
      "allowCombinations": [["_args", "silent"], ["_args", "output"]],
      "values": {
        "_args": "^https://api\\.example\\.com/",
        "output": "^/tmp/"
      }
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
| `flags.<cmd>.values` | Flag → regex its value must match. Every value of a repeated flag must match. |

### Constraining values

Allowing a flag is not the same as constraining it. `"allow": ["output"]` lets the caller write to *any* path, and allowing `_args` lets `curl` fetch *any* URL. `values` closes that:

```json
"values": {
  "_args": "^https://api\\.example\\.com/",
  "output": "^/tmp/"
}
```

Now `curl` may only fetch that one host and only write under `/tmp`. Patterns are unanchored JavaScript regexes tested against each value, so anchor them yourself (`^…$`) — an unanchored `/tmp/` would happily match `/etc/../tmp/../etc/passwd`. A pattern for a flag used as a bare boolean has no value to check and is inert. Broken regexes are rejected when the config loads, not on the first request.

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

## Exit codes and JSON responses

By default a response **streams** the command's merged stdout+stderr as `text/plain`, which is what you want in a browser or a terminal. The cost is that the HTTP status is sent before the command finishes, so it cannot report the command's exit code — a failing command still returns `200` with its error text in the body.

Send `Accept: application/json` to get a buffered response instead:

```bash
curl -X POST http://localhost:3000/curl \
  -H "Content-Type: application/json" -H "Accept: application/json" \
  -d '{"_args": ["http://example.com"], "silent": true}'
```
```json
{
  "command": "curl",
  "args": ["--silent", "http://example.com"],
  "exitCode": 0,
  "stdout": "...",
  "stderr": "",
  "timedOut": false
}
```

This is the mode to use from a script: `exitCode` tells you whether the command actually succeeded, and stdout and stderr arrive separately. The HTTP status stays `200` — the *request* succeeded even when the command didn't.

---

## Limits

Every in-flight request holds a real OS process, so two limits apply:

| Option | Default | Effect |
|---|---|---|
| `--max-concurrency <n>` | `16` | Requests beyond `n` running commands get `429` with `Retry-After`. `0` disables the cap. |
| `--timeout <seconds>` | *(none)* | Kill a command that runs longer. `0` (the default) means no limit. |

A client that hangs up **kills its command** rather than orphaning it, so an abandoned request can't leave a process running forever. That matters most for tools that never exit on their own (`ping`, `tail -f`): without it, every cancelled request would leak a process.

If you wrap something long-running on purpose, leave `--timeout` off — the streaming response delivers output as it is produced.

---

## Browser safety

Bashful runs on the same machine as your browser. Loopback binding keeps the *network* out, but it does not keep out **web pages you visit** — a page's JavaScript can reach `http://localhost:3000` because the request comes from your own machine. Three rules stop a hostile page from driving your wrapped commands:

1. **No CORS headers by default.** A cross-origin page cannot read Bashful's responses, so it cannot exfiltrate command output. Use `--allow-origin <origin>` to permit exactly one origin (`--allow-origin '*'` is possible but re-opens this).
2. **Exec requires `POST` with `Content-Type: application/json`.** A cross-origin "simple" request cannot set that header, so the browser must send a preflight first — and with no CORS headers the preflight fails and the real request is never sent. A POST without the JSON content type gets `415`.
3. **The `Host` header must be loopback.** This defeats DNS rebinding, where an attacker's domain resolves to `127.0.0.1`; their hostname still arrives in the `Host` header. A mismatch gets `421`. The check is skipped when you bind a non-loopback `HOST`, since that is a deliberate opt-in to network access.

`GET /<cmd>` executes a command, which makes it CSRF-able from any page (an `<img src>` is enough) and cannot be protected by a preflight. **It is therefore disabled by default** and returns `405`. `--allow-get` re-enables it for scripting convenience — reasonable on a trusted machine, but understand that it is the one door a hostile page can still knock on.

```bash
bun run bashful.ts --allow-get --allow-origin https://myapp.test curl
```

> [!NOTE]
> None of this is authentication. Any *local* process can still call Bashful. Do not run it on a shared machine you don't trust, and do not expose it to a network without putting real auth in front of it.

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
