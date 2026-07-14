# Architecture

Bashful turns a CLI tool into a REST API by reading its `--help` output. The whole program is one file, `bashful.ts`, with no runtime dependencies beyond Bun.

- [Shape of the program](#shape-of-the-program)
- [Startup flow](#startup-flow)
- [The Bashful Regex](#the-bashful-regex)
- [Payload → CLI translation](#payload--cli-translation)
- [Access control](#access-control)
- [The server](#the-server)
- [Invariants](#invariants)

---

## Shape of the program

`bashful.ts` is split by a single divider comment:

```
┌─ pure functions ─────────────────────────────┐
│  splitSegments      parseSchema              │
│  buildCLIArgs       normalizeConfig          │
│  parseConfig        extractConfigPath        │
│  extractFlagNames   effectiveFlagPolicy      │
│  authorizeCommand   authorizeFlags           │
│  authorizeRequest   filterSchema             │
└──────────────────────────────────────────────┘
// ── Entry point ──────────────────────────────
┌─ imperative shell (if import.meta.main) ─────┐
│  arg parsing → config load → help ingestion  │
│  → schema synthesis → Bun.serve              │
└──────────────────────────────────────────────┘
```

Everything above the divider is exported and free of I/O; `bashful.test.ts` imports it directly. Everything below only runs when the file is executed as a program. **New logic belongs above the divider** — code below it can only be tested by spawning a real server.

---

## Startup flow

1. **Arg parsing.** `--debug` is filtered out, `extractConfigPath` pulls `--config <file>` / `--config=<file>` out of the list, and `splitSegments` splits what remains on `|` / `\|` into one segment per command.

2. **Config load.** `--config`, else `$BASHFUL_CONFIG`, else `./bashful.config.json` if present. `parseConfig` validates the JSON and rejects a malformed policy loudly rather than silently degrading to "allow everything" — a policy file that fails to parse must never become an open door. Each wrapped command is then checked with `authorizeCommand`; a denied one aborts startup.

3. **Help ingestion.** For a single-word segment, Bashful runs the command with `--help`, then `-h`, `-?`, `/?`, stopping at the first flag whose output parses into a non-empty schema. For a multi-word segment (pipe mode) it runs the segment verbatim. Both stdout and stderr are captured, because plenty of tools print their help to stderr. All segments are ingested concurrently.

4. **Schema synthesis.** `parseSchema` turns the help text into a flag schema (below).

5. **Filtering.** `filterSchema` drops any flag the policy would reject on its own, so the schema — and therefore the UI built from it — advertises only what can actually run.

6. **Serve.** The UI HTML is built once as a template literal with the command names baked in; the schemas are pre-serialized. `Bun.serve` then starts on `PORT`/`HOST`.

---

## The Bashful Regex

The heart of the schema synthesis is one regex applied per line of help text:

```
/^\s*(?:(-[a-zA-Z0-9]),?\s+)?(--[a-zA-Z0-9-]+|\/[a-zA-Z0-9]+)\s+(?:<([^>]+)>|\[([^\]]+)\]|([A-Z0-9_]{2,}))?\s+(.*)$/gm
```

It reads a help line as: *optional short flag* → *long flag* → *optional value placeholder* → *description*. The value placeholder is recognized in the three conventions CLIs actually use — `<file>`, `[num]`, and `SECONDS` — and whichever matches becomes the flag's `type`. A flag with no placeholder is a `boolean`. The result is keyed by the long flag with its dashes stripped:

```ts
"output": { shortFlag: "-o", longFlag: "--output", type: "file", description: "Write to file" }
```

This is a **heuristic, not a parser**. Help text is a human-facing format with no standard, so the regex trades completeness for working on the common shape. A tool that formats its help unusually will yield a partial schema — that isn't a fatal error, because unknown keys still translate (see below); it just means the UI won't offer those flags. This is also why direct mode tries several help flags and keeps the first that produces a non-empty schema.

`type` is a free-form string lifted from the help text, not a closed set. Only the exact value `"boolean"` is meaningful to the rest of the program; everything else simply means "this flag takes a value".

---

## Payload → CLI translation

`buildCLIArgs(payload, schema)` turns a JSON object back into an argument array.

- `_args` comes first, so positionals precede flags — `curl --silent http://example.com` and `curl http://example.com --silent` both work for most tools, but the former is the conventional order.
- A key in the schema uses its `longFlag`. Boolean-typed flags emit bare (`--silent`); everything else emits `--flag value`.
- A key **not** in the schema still works: one character becomes `-x`, more becomes `--xyz`. This is what keeps a partial schema usable.
- An **array repeats the flag** once per element (`-H a -H b`), which is how repeatable flags are actually spelled. Joining them into one comma-separated value would be wrong for every tool that has them.
- A value of `false`, `"false"`, `null`, `undefined`, or `[]` emits nothing at all.
- An **object throws `PayloadError`**, which the server turns into a `400`. `String({})` is `'[object Object]'`, and passing that to a command as though it were a real value is worse than refusing.

That last rule has a consequence the access-control layer has to respect: `{"silent": false}` is not a request to use `--silent`, so it must not trip a rule about `silent`. `extractFlagNames` therefore applies the same false-dropping logic before any policy check, keeping the two in agreement.

Arguments are handed to `Bun.spawn` as an array, never a shell string, so no shell metacharacter expansion happens between Bashful and the command.

---

## Access control

The policy layer is four small pure functions over a validated config:

- **`effectiveFlagPolicy(cmd, config)`** merges the `"*"` wildcard policy with the command's own — deny lists concatenate, allow lists union.
- **`authorizeCommand(cmd, config)`** gates the command itself. Deny list first; then, in `whitelist` mode, membership in the allow list.
- **`authorizeFlags(cmd, flags, config)`** gates a set of flags, in a deliberate order: individual denies, then `denyCombinations`, then the allow list, then `allowCombinations`. **Deny is evaluated before allow at every level**, so no combination of rules can make an explicitly denied flag reachable.
- **`authorizeRequest(cmd, payload, config)`** composes the two for one HTTP request.

The two combination rules are set operations over the flags a request actually emits. A `denyCombinations` entry matches when the request is a **superset** of the listed set — `["output", "proxy"]` blocks a request using both plus anything else, while either alone stays legal. `allowCombinations` inverts that: the request's flags must be a **subset** of at least one listed set, so two individually-legal flags drawn from two different sets are rejected together.

Enforcement is deliberately layered, because each layer catches what the others can't:

| Layer | Catches |
|---|---|
| Startup (`authorizeCommand`) | A denied command — fails loudly instead of serving a trap. |
| Request (`authorizeRequest`) | Everything, including payload keys that were never in the parsed schema. This is the only layer that is actually load-bearing for security. |
| Schema (`filterSchema`) | Nothing new — it's a usability layer, so the UI can't render a control whose use would 403. |

`filterSchema` asks `authorizeFlags` about each flag *in isolation*, which is why combination rules can't hide anything: a flag that's only forbidden in company is still legal alone, and is still shown.

---

## The server

One `Bun.serve` handler, routed by hand off the path:

- `GET /`, `/docs`, `/ui` — the pre-rendered HTML UI. It's a self-contained page that fetches `/<cmd>/schema` on load and builds a form per command: a checkbox for each boolean flag, a text input for everything else, plus one field for `_args`. Submitting collects the form into a JSON payload and POSTs it back.
- `GET /<cmd>/schema` — the pre-serialized, policy-filtered schema.
- `POST /<cmd>` / `GET /<cmd>` — authorize, translate, spawn, stream.

Output is streamed rather than buffered: a `ReadableStream` pumps the process's stdout and stderr into one response body, so a long-running command's output arrives as it is produced rather than at exit. CORS is permissive (`*`) since the server is loopback-bound by default.

---

## Invariants

Two properties are load-bearing and easy to undo by accident. Both exist because of real bugs.

**Bind to loopback.** `HOST` defaults to `127.0.0.1`. This process executes arbitrary CLI commands on request; on `0.0.0.0` that is remote command execution for anyone who can reach the port. Widening it must stay an explicit operator decision.

**Keep the browser out.** Loopback binding stops the network but *not* the user's own browser: a page they visit can `fetch('http://localhost:3000/…')`, because that request originates from their machine. Three rules, all in the request path, close that off — no CORS headers unless an origin is explicitly configured (so a hostile page cannot read our output); exec requires `POST` with `Content-Type: application/json` (which no cross-origin *simple* request can set, forcing a preflight that then fails); and the `Host` header must be loopback (defeating DNS rebinding). `GET` exec cannot be protected by a preflight — an `<img src>` triggers it — so it is off unless `--allow-get` is passed. Relaxing any one of these individually re-opens the hole: they only work as a set.

**Merge stderr into the response.** The exec route pumps stdout *and* stderr into one stream. Returning stdout alone means a failing command yields an empty `200` — the user sees nothing at all — and tools that legitimately write to stderr appear silent.

A third, softer one: **`safeSpawn` retries through `cmd /c` on `ENOENT` on Windows**, which is how shell builtins and `.cmd` shims resolve there. Bypassing it breaks Windows for a large class of commands.
