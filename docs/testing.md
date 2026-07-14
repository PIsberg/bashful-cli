# Testing

Tests live in a single file, `bashful.test.ts`, and run on Bun's built-in test runner. There is nothing to install beyond `bun install` and nothing to build.

- [Running tests](#running-tests)
- [How the suite is organized](#how-the-suite-is-organized)
- [Integration tests](#integration-tests)
- [Writing new tests](#writing-new-tests)
- [CI](#ci)

---

## Running tests

```bash
bun test                          # everything
bun test -t "authorizeFlags"      # one describe block, or any test whose name matches
bun test -t "denied combination"  # -t matches against the full "describe > test" name
bun test --watch                  # re-run on change
bunx tsc --noEmit                 # typecheck; tsconfig is noEmit, there is no build step
```

`-t` is the one to reach for while iterating — the integration suites spawn real servers and dominate the wall-clock, so filtering to the unit tests you're working on keeps the loop fast.

---

## How the suite is organized

The suite mirrors the split in `bashful.ts`: pure functions get unit tests, the server gets integration tests.

**Unit tests** — one `describe` per exported pure function:

| Block | Covers |
|---|---|
| `splitSegments` | Splitting args on `\|` into per-command segments; leading, trailing, and empty cases. |
| `parseSchema` | The Bashful Regex against each help-text convention — bare booleans, `-s, --long` pairs, and the `<file>` / `[num]` / `ALLCAPS` value forms. |
| `buildCLIArgs` | Payload → CLI translation, including the fallbacks for keys absent from the schema and the rule that `false` emits nothing. |
| `normalizeConfig` / `parseConfig` | Config validation — that a malformed policy *throws* rather than degrading to "allow everything". |
| `extractConfigPath` | Pulling `--config` out of the arg list in both spellings. |
| `extractFlagNames` | Which payload keys the policy layer actually sees (false-valued flags are dropped, empty `_args` doesn't count). |
| `effectiveFlagPolicy` | Merging the `"*"` wildcard policy with a command's own. |
| `authorizeCommand` / `authorizeFlags` / `authorizeRequest` | The decision logic: whitelist vs blacklist, deny-beats-allow, and both combination forms. |
| `filterSchema` | That forbidden flags are hidden from the schema — and that combination rules *don't* hide individually-legal flags. |

Because these functions are pure, testing a policy takes no server and no fixtures — build a config with `normalizeConfig({...})` and assert on the returned `Decision`:

```ts
const config = normalizeConfig({ flags: { curl: { denyCombinations: [['output', 'proxy']] } } });
expect(authorizeFlags('curl', ['output'], config).allowed).toBe(true);
expect(authorizeFlags('curl', ['output', 'proxy'], config).allowed).toBe(false);
```

---

## Integration tests

Three `describe` blocks boot the real program with `spawn(['bun', 'run', './bashful.ts', ...])` and drive it over HTTP:

| Suite | Port | Asserts |
|---|---|---|
| `Integration: HTTP Server Routing` | 3005 | The UI, schema, and exec routes; `POST` and `GET` execution; 404s; and that **stderr reaches the response body** — a regression guard, since returning stdout alone silently produced empty `200`s. |
| `Integration: config enforcement` | 3006 (+3007, 3008) | `403` with a reason for a denied flag and a denied combination; that either half of a denied pair still works alone; that the block applies to query params too; and that a denied command or a missing `--config` file **exits non-zero at startup**. |
| `Integration: whitelist mode` | 3009 | That only whitelisted flags run, and that the served schema advertises nothing else. |

They wrap `bun` itself as the target command — it's guaranteed present, its `--version` output is trivially assertable, and it needs no network.

Two mechanics worth knowing before you add one:

- **Ports are hardcoded and must not collide.** 3005–3009 are taken. A new suite needs its own free port, passed through `env: { ...process.env, PORT: String(PORT) }`.
- **Policy fixtures are written to `tmpdir()`** and passed with `--config <path>`, never committed to the repo. This matters: Bashful auto-loads `./bashful.config.json` if it exists, so a policy file left in the repo root would silently apply to every other test — and to anyone running the tool locally.

Each suite waits ~600 ms in `beforeAll` for the server to come up and kills the process in `afterAll`. Startup-failure tests don't need the wait; they read the child's stderr and await `proc.exited`.

---

## Writing new tests

The rule of thumb follows the architecture: **if logic can live above the `// ── Entry point ──` divider in `bashful.ts`, put it there and unit-test it.** Code below the divider runs only under `if (import.meta.main)` and can be exercised only by spawning a real process, which is slower, flakier, and harder to assert on. The policy layer is the worked example — every decision rule is a pure function, so the integration tests only need to prove the wiring (that a `403` is actually returned and the command actually doesn't spawn), not re-litigate each rule.

Reach for an integration test when the thing under test *is* the wiring: a route, a status code, a stream, an exit code, or a startup refusal.

---

## CI

`.github/workflows/test.yml` runs `bun install` and `bun test` on every push and pull request to `main`. Lint is not wired into `package.json` — ESLint, gitleaks, and the whitespace fixers run through [`.pre-commit-config.yaml`](../.pre-commit-config.yaml).
