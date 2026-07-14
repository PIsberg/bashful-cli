// Pure functions — exported for testing

/** Split CLI args by '|' into segments, each representing one command. */
export function splitSegments(args: string[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  for (const arg of args) {
    if (arg === '|' || arg === '\\|') {
      if (current.length > 0) { segments.push(current); current = []; }
    } else {
      current.push(arg);
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

// The "Bashful Regex" reads one help line as:
//   [short flag ,] <flag> [=|SPACE <value>]  [two spaces] [description]
// where <flag> is a long flag (--foo), a Windows-style flag (/foo), or a short
// flag standing on its own (-v). A value is separated by '=' or exactly one
// space — two or more spaces mean the description started, which stops an
// acronym ("--quiet    URL to fetch") from being read as a value type.
const SCHEMA_REGEX =
  /^[ \t]*(?:(-[a-zA-Z0-9])(?:,|[ \t])[ \t]*(?=[-/]))?(--[a-zA-Z0-9][a-zA-Z0-9-]*|\/[a-zA-Z0-9?]+|-[a-zA-Z0-9])(?:[= ](?:<([^>]+)>|\[([^\]]+)\]|([A-Z][A-Z0-9_]+)))?(?:[ \t]{2,}(.*?))?[ \t]*$/gm;

/** Parse --help text into a flag schema using the "Bashful Regex". */
export function parseSchema(helpText: string): Record<string, any> {
  const schema: Record<string, any> = {};
  for (const match of helpText.matchAll(SCHEMA_REGEX)) {
    const [, shortPartner, flag, type1, type2, type3, description] = match;
    if (!flag) continue;

    const isShortOnly = flag.startsWith('-') && !flag.startsWith('--');
    // `flag` is what we emit; for a short-only flag that *is* the short flag.
    const shortFlag = shortPartner ?? (isShortOnly ? flag : undefined);
    const key = flag.startsWith('--') ? flag.slice(2) : isShortOnly ? flag.slice(1) : flag;

    // Help texts often mention a flag again in examples; the definition comes first.
    if (schema[key]) continue;

    schema[key] = {
      shortFlag,
      longFlag: flag,
      type: type1 || type2 || type3 || 'boolean',
      description: (description ?? '').trim(),
    };
  }
  return schema;
}

/** Thrown for a payload we refuse to translate. The server turns this into a 400. */
export class PayloadError extends Error {}

/**
 * Render one payload value as a CLI string. Objects have no sane CLI spelling —
 * String({}) is '[object Object]', which would be passed to the command as if it
 * were a real value, so reject them instead.
 */
function scalarToArg(value: unknown, key: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    if (!Number.isFinite(value as number) && typeof value === 'number') {
      throw new PayloadError(`'${key}': ${value} is not a valid value`);
    }
    return String(value);
  }
  throw new PayloadError(`'${key}': ${Array.isArray(value) ? 'nested arrays are' : `${value === null ? 'null' : typeof value} is`} not a valid value`);
}

const isOff = (value: unknown) => value === false || value === 'false';
const isOn = (value: unknown) => value === true || value === 'true';

/** Translate a JSON payload into a CLI argument array, using the schema for flag lookup. */
export function buildCLIArgs(payload: Record<string, any>, schema: Record<string, any>): string[] {
  const cliArgs: string[] = [];

  const positionals = payload._args;
  if (Array.isArray(positionals)) {
    cliArgs.push(...positionals.map(arg => scalarToArg(arg, '_args')));
  } else if (typeof positionals === 'string') {
    cliArgs.push(positionals);
  } else if (positionals != null) {
    throw new PayloadError("'_args' must be a string or an array of strings");
  }

  for (const [key, value] of Object.entries(payload)) {
    if (key === '_args') continue;
    if (value == null || isOff(value)) continue; // builds to nothing

    const flagDef = schema[key];
    const flag: string = flagDef ? flagDef.longFlag : key.length === 1 ? `-${key}` : `--${key}`;
    const isBooleanFlag = flagDef ? flagDef.type === 'boolean' : false;

    // An array repeats the flag once per element — `-H a -H b`, not `-H "a,b"`.
    // This is how repeatable flags (curl -H, docker -e, …) are actually spelled.
    const values = Array.isArray(value) ? value : [value];
    if (Array.isArray(value) && value.length === 0) continue;

    for (const item of values) {
      if (isBooleanFlag || isOn(item)) {
        if (!isOff(item)) cliArgs.push(flag);
      } else {
        cliArgs.push(flag, scalarToArg(item, key));
      }
    }
  }

  return cliArgs;
}

// ── Access control (whitelist / blacklist) ───────────────────────────────────

export type FlagPolicy = {
  allow?: string[];
  deny?: string[];
  allowCombinations?: string[][];
  denyCombinations?: string[][];
  /** Flag name → regex the flag's value(s) must match. Use '_args' for positionals. */
  values?: Record<string, string>;
};

export type BashfulConfig = {
  /** 'blacklist' (default): everything is allowed unless denied.
   *  'whitelist': nothing is allowed unless explicitly allowed. */
  mode: 'whitelist' | 'blacklist';
  commands: { allow?: string[]; deny?: string[] };
  /** Keyed by command name; the '*' key applies to every command. */
  flags: Record<string, FlagPolicy>;
};

export type Decision = { allowed: true } | { allowed: false; reason: string };

const ALLOWED: Decision = { allowed: true };

export const DEFAULT_CONFIG: BashfulConfig = { mode: 'blacklist', commands: {}, flags: {} };

function asStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) {
    throw new Error(`config: '${path}' must be an array of strings`);
  }
  return value as string[];
}

function asCombinations(value: unknown, path: string): string[][] {
  if (!Array.isArray(value)) throw new Error(`config: '${path}' must be an array of arrays of strings`);
  return value.map((combo, i) => asStringArray(combo, `${path}[${i}]`));
}

/** Validate and normalize a raw config object (as parsed from JSON). */
export function normalizeConfig(raw: unknown): BashfulConfig {
  if (raw == null) return DEFAULT_CONFIG;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config: root must be an object');
  const obj = raw as Record<string, unknown>;

  const mode = obj.mode ?? 'blacklist';
  if (mode !== 'whitelist' && mode !== 'blacklist') {
    throw new Error(`config: 'mode' must be "whitelist" or "blacklist" (got ${JSON.stringify(mode)})`);
  }

  const commands: BashfulConfig['commands'] = {};
  if (obj.commands != null) {
    if (typeof obj.commands !== 'object' || Array.isArray(obj.commands)) {
      throw new Error("config: 'commands' must be an object");
    }
    const c = obj.commands as Record<string, unknown>;
    if (c.allow != null) commands.allow = asStringArray(c.allow, 'commands.allow');
    if (c.deny != null) commands.deny = asStringArray(c.deny, 'commands.deny');
  }

  const flags: BashfulConfig['flags'] = {};
  if (obj.flags != null) {
    if (typeof obj.flags !== 'object' || Array.isArray(obj.flags)) {
      throw new Error("config: 'flags' must be an object keyed by command name");
    }
    for (const [cmd, rawPolicy] of Object.entries(obj.flags as Record<string, unknown>)) {
      if (typeof rawPolicy !== 'object' || rawPolicy == null || Array.isArray(rawPolicy)) {
        throw new Error(`config: 'flags.${cmd}' must be an object`);
      }
      const p = rawPolicy as Record<string, unknown>;
      const policy: FlagPolicy = {};
      if (p.allow != null) policy.allow = asStringArray(p.allow, `flags.${cmd}.allow`);
      if (p.deny != null) policy.deny = asStringArray(p.deny, `flags.${cmd}.deny`);
      if (p.allowCombinations != null) policy.allowCombinations = asCombinations(p.allowCombinations, `flags.${cmd}.allowCombinations`);
      if (p.denyCombinations != null) policy.denyCombinations = asCombinations(p.denyCombinations, `flags.${cmd}.denyCombinations`);
      if (p.values != null) {
        if (typeof p.values !== 'object' || Array.isArray(p.values)) {
          throw new Error(`config: 'flags.${cmd}.values' must be an object of flag → regex`);
        }
        const values: Record<string, string> = {};
        for (const [flag, pattern] of Object.entries(p.values as Record<string, unknown>)) {
          if (typeof pattern !== 'string') {
            throw new Error(`config: 'flags.${cmd}.values.${flag}' must be a regex string`);
          }
          // Compile now so a broken pattern fails at startup, not on the first
          // request — a policy that throws at request time is a policy that
          // might not be enforced.
          try {
            new RegExp(pattern);
          } catch (err: any) {
            throw new Error(`config: 'flags.${cmd}.values.${flag}' is not a valid regex — ${err.message}`);
          }
          values[flag] = pattern;
        }
        policy.values = values;
      }
      flags[cmd] = policy;
    }
  }

  return { mode, commands, flags };
}

/** Parse config JSON text into a validated config. */
export function parseConfig(text: string): BashfulConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err: any) {
    throw new Error(`config: invalid JSON — ${err.message}`);
  }
  return normalizeConfig(raw);
}

/** Merge the wildcard ('*') policy with a command-specific policy. */
export function effectiveFlagPolicy(command: string, config: BashfulConfig): FlagPolicy {
  const wildcard = config.flags['*'];
  const specific = config.flags[command];
  if (!wildcard) return specific ?? {};
  if (!specific) return wildcard;
  const merge = <T>(a?: T[], b?: T[]) => (a || b ? [...(a ?? []), ...(b ?? [])] : undefined);
  return {
    allow: merge(wildcard.allow, specific.allow),
    deny: merge(wildcard.deny, specific.deny),
    allowCombinations: merge(wildcard.allowCombinations, specific.allowCombinations),
    denyCombinations: merge(wildcard.denyCombinations, specific.denyCombinations),
    // A command's own pattern for a flag overrides the wildcard's.
    values: wildcard.values || specific.values
      ? { ...wildcard.values, ...specific.values }
      : undefined,
  };
}

/** The values a payload would emit for one flag, as strings. Bare booleans emit none. */
export function extractFlagValues(payload: Record<string, any>): Record<string, string[]> {
  const values: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value == null) continue;
    const items = Array.isArray(value) ? value : [value];
    const rendered = items
      .filter(item => typeof item !== 'boolean' && item !== 'true' && item !== 'false')
      .map(item => String(item));
    if (rendered.length > 0) values[key] = rendered;
  }
  return values;
}

/**
 * Check flag values against their configured patterns. This is what makes a
 * whitelist actually contain something: allowing '--output' is meaningless if
 * the caller picks the path.
 */
export function authorizeValues(
  command: string,
  payload: Record<string, any>,
  config: BashfulConfig
): Decision {
  const patterns = effectiveFlagPolicy(command, config).values;
  if (!patterns) return ALLOWED;

  const values = extractFlagValues(payload);
  for (const [flag, pattern] of Object.entries(patterns)) {
    const used = values[flag];
    if (!used) continue; // flag absent, or used as a bare boolean — no value to check
    const regex = new RegExp(pattern);
    for (const value of used) {
      if (!regex.test(value)) {
        return {
          allowed: false,
          reason: `value '${value}' for '${flag}' does not match the required pattern ${pattern} for command '${command}'`,
        };
      }
    }
  }
  return ALLOWED;
}

/**
 * The flag names a payload would actually emit — omits flags that build to
 * nothing. This must stay in lockstep with buildCLIArgs: a value it drops must
 * be dropped here too, or the policy would judge a flag that never runs.
 */
export function extractFlagNames(payload: Record<string, any>): string[] {
  const names: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (key === '_args') {
      const nonEmpty = Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.length > 0;
      if (nonEmpty) names.push('_args');
      continue;
    }
    if (value == null || value === false || value === 'false') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    names.push(key);
  }
  return names;
}

const listed = (list: string[] | undefined, name: string) => !!list && (list.includes(name) || list.includes('*'));

/** Decide whether a command may be wrapped/executed at all. */
export function authorizeCommand(command: string, config: BashfulConfig): Decision {
  if (listed(config.commands.deny, command)) {
    return { allowed: false, reason: `command '${command}' is denied by config` };
  }
  if (config.mode === 'whitelist' && !listed(config.commands.allow, command)) {
    return { allowed: false, reason: `command '${command}' is not in the whitelist (commands.allow)` };
  }
  return ALLOWED;
}

/** Decide whether a specific set of flags may be used with a command. Deny always beats allow. */
export function authorizeFlags(command: string, flagNames: string[], config: BashfulConfig): Decision {
  const policy = effectiveFlagPolicy(command, config);

  for (const name of flagNames) {
    if (listed(policy.deny, name)) {
      return { allowed: false, reason: `flag '${name}' is denied for command '${command}'` };
    }
  }

  for (const combo of policy.denyCombinations ?? []) {
    if (combo.length > 0 && combo.every(name => flagNames.includes(name))) {
      return {
        allowed: false,
        reason: `flag combination [${combo.join(', ')}] is denied for command '${command}'`,
      };
    }
  }

  const enforceAllow = config.mode === 'whitelist' || policy.allow != null;
  if (enforceAllow) {
    for (const name of flagNames) {
      if (!listed(policy.allow, name)) {
        return { allowed: false, reason: `flag '${name}' is not in the whitelist for command '${command}'` };
      }
    }
  }

  const allowCombos = policy.allowCombinations;
  if (allowCombos && allowCombos.length > 0 && flagNames.length > 0) {
    const permitted = allowCombos.some(combo => flagNames.every(name => combo.includes(name)));
    if (!permitted) {
      return {
        allowed: false,
        reason: `flag combination [${flagNames.join(', ')}] is not an allowed combination for command '${command}'`,
      };
    }
  }

  return ALLOWED;
}

/**
 * Drop flags the policy would reject on their own, so the schema and UI only
 * advertise what can actually be run. Combination rules still apply at request
 * time — they depend on which flags are used together, not on a single flag.
 */
export function filterSchema(
  command: string,
  schema: Record<string, any>,
  config: BashfulConfig
): Record<string, any> {
  const filtered: Record<string, any> = {};
  for (const [name, def] of Object.entries(schema)) {
    if (authorizeFlags(command, [name], config).allowed) filtered[name] = def;
  }
  return filtered;
}

/** Full check for one request: the command, then its flags, then their values. */
export function authorizeRequest(command: string, payload: Record<string, any>, config: BashfulConfig): Decision {
  const cmdDecision = authorizeCommand(command, config);
  if (!cmdDecision.allowed) return cmdDecision;

  const flagDecision = authorizeFlags(command, extractFlagNames(payload), config);
  if (!flagDecision.allowed) return flagDecision;

  return authorizeValues(command, payload, config);
}

// ── Entry point ──────────────────────────────────────────────────────────────

function safeSpawn(args: string[], options: any) {
  try {
    return Bun.spawn(args, options);
  } catch (err: any) {
    if (err.code === 'ENOENT' && process.platform === 'win32') {
       return Bun.spawn(['cmd', '/c', ...args], options);
    }
    throw err;
  }
}

// ── Request hardening ────────────────────────────────────────────────────────
//
// This server executes CLI commands, and it runs on the same machine as the
// user's browser. Loopback binding keeps the *network* out, but it does nothing
// about a web page the user happens to be visiting: that page shares the user's
// machine, so `fetch('http://localhost:3000/...')` reaches us. Three rules keep
// a hostile page from driving Bashful:
//
//   1. No CORS by default — a cross-origin page cannot read our responses.
//   2. Exec requires POST + `Content-Type: application/json` — a "simple"
//      cross-origin request cannot set that header, so the browser must
//      preflight, and with no CORS headers the preflight fails and the request
//      is never sent. GET exec re-opens this hole and is therefore opt-in.
//   3. The Host header must be loopback — this is what defeats DNS rebinding,
//      where an attacker-controlled name resolves to 127.0.0.1.

export type ServerOptions = {
  configPath?: string;
  /** Allow `GET /<cmd>` to execute. Off by default: it is CSRF-able. */
  allowGet: boolean;
  /** Origin to send CORS headers for. Unset means no CORS headers at all. */
  allowOrigin?: string;
  /** Kill a command that runs longer than this. 0 = no limit. */
  timeoutMs: number;
  /** Reject exec requests beyond this many in flight. 0 = no limit. */
  maxConcurrent: number;
};

/** Parse a non-negative number option, rejecting the nonsense early. */
export function parseNumberOption(value: string, flag: string): number {
  // Number('') is 0 and Number('  ') is 0, which would silently accept nonsense.
  const n = value.trim() === '' ? NaN : Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} must be a non-negative number (got '${value}')`);
  return n;
}

/** A client asking for JSON wants the exit code, so we buffer instead of streaming. */
export function wantsJson(accept: string | null): boolean {
  if (!accept) return false;
  return accept.split(',').some(part => part.split(';')[0]!.trim().toLowerCase() === 'application/json');
}

/** Pull Bashful's own options out of the arg list, leaving the wrapped command. */
export function extractOptions(args: string[]): ServerOptions & { rest: string[] } {
  const rest: string[] = [];
  const options: ServerOptions & { rest: string[] } = {
    allowGet: false,
    timeoutMs: 0,
    maxConcurrent: DEFAULT_MAX_CONCURRENT,
    rest,
  };

  const valueOf = (i: number, flag: string): [string, number] => {
    const arg = args[i]!;
    if (arg.startsWith(`${flag}=`)) {
      const value = arg.slice(flag.length + 1);
      if (!value) throw new Error(`${flag} requires a value`);
      return [value, i];
    }
    const next = args[i + 1];
    if (next === undefined || next.startsWith('-')) throw new Error(`${flag} requires a value`);
    return [next, i + 1];
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--config' || arg.startsWith('--config=')) {
      [options.configPath, i] = valueOf(i, '--config');
    } else if (arg === '--allow-origin' || arg.startsWith('--allow-origin=')) {
      [options.allowOrigin, i] = valueOf(i, '--allow-origin');
    } else if (arg === '--timeout' || arg.startsWith('--timeout=')) {
      let seconds: string;
      [seconds, i] = valueOf(i, '--timeout');
      options.timeoutMs = parseNumberOption(seconds, '--timeout') * 1000;
    } else if (arg === '--max-concurrency' || arg.startsWith('--max-concurrency=')) {
      let value: string;
      [value, i] = valueOf(i, '--max-concurrency');
      options.maxConcurrent = parseNumberOption(value, '--max-concurrency');
    } else if (arg === '--allow-get') {
      options.allowGet = true;
    } else {
      rest.push(arg);
    }
  }
  return options;
}

/** Hostname from a Host header, minus the port. Handles bracketed IPv6. */
export function parseHostHeader(hostHeader: string | null): string | null {
  if (!hostHeader) return null;
  const value = hostHeader.trim();
  if (!value) return null;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end === -1 ? null : value.slice(1, end).toLowerCase();
  }
  const colon = value.indexOf(':');
  return (colon === -1 ? value : value.slice(0, colon)).toLowerCase();
}

export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/**
 * Reject a request whose Host header isn't loopback — that's a DNS-rebinding
 * attempt. If the operator bound a non-loopback interface they deliberately
 * opted into network access, so we stop second-guessing them.
 */
export function isAllowedHost(hostHeader: string | null, bindHost: string): boolean {
  if (!isLoopbackHost(bindHost)) return true;
  const host = parseHostHeader(hostHeader);
  return host !== null && isLoopbackHost(host);
}

/** CORS headers for a request. No allowed origin configured → no headers, which is what we want. */
export function buildCorsHeaders(origin: string | null, allowOrigin?: string): Record<string, string> {
  if (!allowOrigin) return {};
  const common = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (allowOrigin === '*') return { 'Access-Control-Allow-Origin': '*', ...common };
  if (origin && origin === allowOrigin) {
    return { 'Access-Control-Allow-Origin': allowOrigin, Vary: 'Origin', ...common };
  }
  return {};
}

/** A JSON body is what forces a preflight on cross-origin POSTs. */
export function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  return contentType.split(';')[0]!.trim().toLowerCase() === 'application/json';
}

const DEFAULT_CONFIG_FILE = 'bashful.config.json';
/** Each in-flight request holds a real OS process, so this is bounded by default. */
const DEFAULT_MAX_CONCURRENT = 16;

if (import.meta.main) {
  const isDebug = process.argv.includes('--debug');
  if (isDebug) console.time('Bashful Startup');

  const rawArgs = process.argv.slice(2).filter(arg => arg !== '--debug');

  let options: ServerOptions;
  let args: string[];
  try {
    const { rest, ...opts } = extractOptions(rawArgs);
    options = opts;
    args = rest;
  } catch (err: any) {
    console.error(`[Bashful] ${err.message}`);
    process.exit(1);
  }
  const { configPath, allowGet, allowOrigin, timeoutMs, maxConcurrent } = options;

  if (args.length === 0) {
    console.error('Usage: bashful [--debug] [--config <file>] [--allow-get] [--allow-origin <origin>]');
    console.error('               [--timeout <seconds>] [--max-concurrency <n>] <command> [args...] [\\| <command2> ...]');
    console.error('Example: bashful curl \\| wget');
    console.error('Example: bashful curl --help \\| wget --help');
    console.error('Example: bashful --config bashful.config.json curl');
    process.exit(1);
  }

  // Explicit --config, then $BASHFUL_CONFIG, then ./bashful.config.json if it happens to exist.
  const explicitPath = configPath ?? process.env.BASHFUL_CONFIG;
  let config = DEFAULT_CONFIG;
  try {
    const path = explicitPath ?? DEFAULT_CONFIG_FILE;
    const file = Bun.file(path);
    if (await file.exists()) {
      config = parseConfig(await file.text());
      if (isDebug) console.log(`[Bashful] Loaded config from '${path}' (mode: ${config.mode}).`);
    } else if (explicitPath) {
      console.error(`[Bashful] Config file not found: '${explicitPath}'`);
      process.exit(1);
    }
  } catch (err: any) {
    console.error(`[Bashful] ${err.message}`);
    process.exit(1);
  }

  const segments = splitSegments(args);

  for (const segment of segments) {
    const decision = authorizeCommand(segment[0]!, config);
    if (!decision.allowed) {
      console.error(`[Bashful] Refusing to wrap: ${decision.reason}`);
      process.exit(1);
    }
  }

  const commandPromises = segments.map(async (segment) => {
    const name = segment[0];
    const executeAndRead = async (args: string[]) => {
      let stdout = '', stderr = '';
      try {
        const proc = safeSpawn(args, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
        [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text()
        ]);
      } catch (err: any) {
        stderr = err.message || String(err);
      }
      return stdout + stderr;
    };

    let helpText = '';
    if (segment.length === 1) {
      for (const flag of ['--help', '-h', '-?', '/?']) {
        helpText = await executeAndRead([name, flag]);
        if (Object.keys(parseSchema(helpText)).length > 0) {
          break; // Found a valid schema, stop trying alternate help flags
        }
      }
    } else {
      helpText = await executeAndRead(segment);
    }
    
    const schema = parseSchema(helpText);
    if (isDebug) console.log(`[Bashful] Parsed schema for '${name}':`, Object.keys(schema).length, 'flags found.');
    return { name, schema };
  });

  const commands = await Promise.all(commandPromises);

  const commandNames = commands.map(c => c.name);

  const swaggerHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bashful UI - ${commandNames.join(' | ')}</title>
    <style>
        body { font-family: system-ui, -apple-system, sans-serif; max-width: 900px; margin: 0 auto; padding: 2rem; background: #f3f4f6; color: #1f2937; }
        h1 { border-bottom: 2px solid #e5e7eb; padding-bottom: 0.5rem; margin-bottom: 1.5rem; }
        .tabs { display: flex; gap: 0.25rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
        .tab-btn { background: #e5e7eb; border: none; padding: 0.5rem 1rem; border-radius: 0.375rem 0.375rem 0 0; cursor: pointer; font-weight: 600; font-size: 0.95rem; color: #374151; transition: background 0.15s; }
        .tab-btn:hover { background: #d1d5db; }
        .tab-btn.active { background: white; color: #2563eb; box-shadow: 0 -1px 3px rgba(0,0,0,0.1); }
        .tab-panel { display: none; }
        .tab-panel.active { display: block; }
        .card { background: white; padding: 1.5rem; border-radius: 0 0.5rem 0.5rem 0.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 1.5rem; }
        .form-group { margin-bottom: 1rem; padding-bottom: 1rem; border-bottom: 1px solid #f3f4f6; }
        .form-group:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
        label { display: block; font-weight: 600; margin-bottom: 0.25rem; }
        .desc { font-size: 0.875rem; color: #6b7280; margin-bottom: 0.5rem; }
        input[type="text"] { width: 100%; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 0.25rem; box-sizing: border-box; font-family: monospace; }
        input[type="checkbox"] { margin-right: 0.5rem; transform: scale(1.2); }
        .checkbox-label { display: flex; align-items: center; font-weight: 600; cursor: pointer; }
        button.exec-btn { background: #2563eb; color: white; border: none; padding: 0.75rem 1.5rem; border-radius: 0.25rem; cursor: pointer; font-weight: bold; font-size: 1rem; width: 100%; transition: background 0.2s; }
        button.exec-btn:hover { background: #1d4ed8; }
        pre { background: #111827; color: #e5e7eb; padding: 1rem; border-radius: 0.5rem; overflow-x: auto; white-space: pre-wrap; font-family: monospace; min-height: 100px; }
        .badge { display: inline-block; padding: 0.1rem 0.4rem; background: #e5e7eb; color: #374151; border-radius: 0.25rem; font-size: 0.75rem; font-family: monospace; margin-left: 0.5rem; }
    </style>
</head>
<body>
    <h1>Bashful UI</h1>
    <div class="tabs" id="tabs"></div>
    <div id="panels"></div>

    <script>
        const commands = ${JSON.stringify(commandNames)};

        function buildForm(cmd, schema) {
            const panel = document.createElement('div');
            panel.className = 'tab-panel';
            panel.id = 'panel-' + cmd;

            const formCard = document.createElement('div');
            formCard.className = 'card';

            const form = document.createElement('form');
            form.id = 'form-' + cmd;

            const argsGroup = document.createElement('div');
            argsGroup.className = 'form-group';
            argsGroup.innerHTML = '<label>Positional Arguments (_args)</label><div class="desc">Arguments passed without flags (space separated)</div>';
            const argsInput = document.createElement('input');
            argsInput.type = 'text';
            argsInput.name = '_args';
            argsInput.placeholder = 'e.g. http://example.com';
            argsGroup.appendChild(argsInput);
            form.appendChild(argsGroup);

            const flagsContainer = document.createElement('div');
            for (const [key, def] of Object.entries(schema)) {
                const div = document.createElement('div');
                div.className = 'form-group';
                const isBool = def.type === 'boolean';
                // def.longFlag is the flag as it will actually be emitted — for a
                // short-only flag that is '-v', not '--v'.
                const flagText = (def.longFlag || '--' + key)
                    + (def.shortFlag && def.shortFlag !== def.longFlag ? ' (' + def.shortFlag + ')' : '');
                if (isBool) {
                    const label = document.createElement('label');
                    label.className = 'checkbox-label';
                    const input = document.createElement('input');
                    input.type = 'checkbox';
                    input.name = key;
                    label.appendChild(input);
                    label.appendChild(document.createTextNode(flagText));
                    const badge = document.createElement('span');
                    badge.className = 'badge';
                    badge.textContent = def.type;
                    label.appendChild(badge);
                    div.appendChild(label);
                } else {
                    const label = document.createElement('label');
                    label.textContent = flagText;
                    const badge = document.createElement('span');
                    badge.className = 'badge';
                    badge.textContent = def.type;
                    label.appendChild(badge);
                    div.appendChild(label);
                }
                const desc = document.createElement('div');
                desc.className = 'desc';
                desc.textContent = def.description;
                div.appendChild(desc);
                if (!isBool) {
                    const input = document.createElement('input');
                    input.type = 'text';
                    input.name = key;
                    div.appendChild(input);
                }
                flagsContainer.appendChild(div);
            }
            form.appendChild(flagsContainer);

            const btnWrap = document.createElement('div');
            btnWrap.style.marginTop = '1.5rem';
            const btn = document.createElement('button');
            btn.type = 'submit';
            btn.className = 'exec-btn';
            btn.textContent = 'Execute ' + cmd;
            btnWrap.appendChild(btn);
            form.appendChild(btnWrap);

            formCard.appendChild(form);
            panel.appendChild(formCard);

            const outCard = document.createElement('div');
            outCard.className = 'card';
            outCard.innerHTML = '<h2 style="margin-top:0">Output</h2>';
            const pre = document.createElement('pre');
            pre.id = 'output-' + cmd;
            pre.textContent = 'Ready.';
            outCard.appendChild(pre);
            panel.appendChild(outCard);

            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                const outputEl = document.getElementById('output-' + cmd);
                btn.disabled = true;
                btn.textContent = 'Running...';
                outputEl.textContent = 'Executing...';

                const payload = {};
                const argsVal = form.querySelector('[name="_args"]').value;
                if (argsVal) payload._args = argsVal.split(' ').filter(Boolean);

                form.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                    if (cb.checked) payload[cb.name] = true;
                });
                form.querySelectorAll('input[type="text"]').forEach(input => {
                    if (input.name !== '_args' && input.value.trim()) payload[input.name] = input.value.trim();
                });

                try {
                    const res = await fetch('/' + cmd, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                    outputEl.textContent = await res.text();
                } catch (err) {
                    outputEl.textContent = 'Error: ' + err.message;
                } finally {
                    btn.disabled = false;
                    btn.textContent = 'Execute ' + cmd;
                }
            });

            return panel;
        }

        async function init() {
            const tabsEl = document.getElementById('tabs');
            const panelsEl = document.getElementById('panels');

            for (const cmd of commands) {
                const res = await fetch('/' + cmd + '/schema');
                const schema = await res.json();

                const tabBtn = document.createElement('button');
                tabBtn.className = 'tab-btn';
                tabBtn.textContent = cmd;
                tabBtn.dataset.cmd = cmd;
                tabBtn.addEventListener('click', () => switchTab(cmd));
                tabsEl.appendChild(tabBtn);

                panelsEl.appendChild(buildForm(cmd, schema));
            }

            switchTab(commands[0]);
        }

        function switchTab(cmd) {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.cmd === cmd));
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + cmd));
        }

        init();
    </script>
</body>
</html>`;

  const PORT = parseInt(process.env.PORT || '3000', 10);
  // Bind to localhost by default: this server executes arbitrary CLI commands,
  // so it must not be exposed to the network unless deliberately opted in.
  const HOST = process.env.HOST || '127.0.0.1';
  // Only expose flags the policy permits — the UI is built from this schema.
  const visibleSchemas = commands.map(c => ({ name: c.name, schema: filterSchema(c.name, c.schema, config) }));
  const commandMap = new Map(visibleSchemas.map(c => [c.name, c.schema]));
  const serializedSchemas = new Map(visibleSchemas.map(c => [c.name, JSON.stringify(c.schema, null, 2)]));

  /** Number of commands currently running. Bounded by --max-concurrency. */
  let inFlight = 0;

  const server = Bun.serve({
    port: PORT,
    hostname: HOST,
    async fetch(req) {
      const corsHeaders = buildCorsHeaders(req.headers.get('origin'), allowOrigin);

      // Defeats DNS rebinding: an attacker's name resolving to 127.0.0.1 still
      // carries their hostname in the Host header.
      if (!isAllowedHost(req.headers.get('host'), HOST)) {
        if (isDebug) console.log(`[Bashful] Rejected Host header: ${req.headers.get('host')}`);
        return new Response('Invalid Host header.', { status: 421 });
      }

      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      const pathStart = req.url.indexOf('/', 8);
      const fullPath = pathStart !== -1 ? req.url.slice(pathStart) : '/';
      const searchStart = fullPath.indexOf('?');
      const pathname = searchStart !== -1 ? fullPath.slice(0, searchStart) : fullPath;

      if (req.method === 'GET' && (pathname === '/' || pathname === '/docs' || pathname === '/ui')) {
        return new Response(swaggerHtml, {
          headers: { ...corsHeaders, 'Content-Type': 'text/html' }
        });
      }

      const parts = pathname.substring(1).split('/');
      const cmdName = parts[0];

      if (commandMap.has(cmdName)) {
        if (req.method === 'GET' && parts[1] === 'schema') {
          const schemaString = serializedSchemas.get(cmdName);
          if (schemaString) {
            return new Response(schemaString, {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
          }
        } else if (parts.length === 1 && (req.method === 'POST' || req.method === 'GET')) {
          const schema = commandMap.get(cmdName)!;

          // GET executes a command, so it is CSRF-able from any page the user
          // visits (an <img> tag is enough). Opt-in only.
          if (req.method === 'GET' && !allowGet) {
            return new Response(
              JSON.stringify({
                error: 'Method Not Allowed',
                reason: 'GET execution is disabled. Use POST, or start Bashful with --allow-get.',
              }),
              { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json', Allow: 'POST' } }
            );
          }

          // Requiring a JSON body is what forces the browser to preflight a
          // cross-origin POST — which then fails, since we send no CORS headers.
          if (req.method === 'POST' && !isJsonContentType(req.headers.get('content-type'))) {
            return new Response(
              JSON.stringify({
                error: 'Unsupported Media Type',
                reason: "Exec requests must send 'Content-Type: application/json'.",
              }),
              { status: 415, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
          }

          try {
            let payload: Record<string, any> = {};
            if (req.method === 'POST') {
              payload = await req.json().catch(() => ({}));
            } else {
              const qs = searchStart !== -1 ? fullPath.slice(searchStart) : '';
              const params = new URLSearchParams(qs);
              for (const key of new Set(params.keys())) {
                // A repeated param becomes an array, so ?h=a&h=b repeats the flag
                // rather than silently keeping only the last value.
                const values = params.getAll(key);
                payload[key] = values.length > 1 ? values : values[0];
              }
            }

            const decision = authorizeRequest(cmdName, payload, config);
            if (!decision.allowed) {
              if (isDebug) console.log(`[Bashful] Blocked: ${decision.reason}`);
              return new Response(JSON.stringify({ error: 'Forbidden', reason: decision.reason }), {
                status: 403,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
              });
            }

            // Every in-flight request holds an OS process. Without a cap, N
            // concurrent requests fork N processes with nothing bounding N.
            if (maxConcurrent > 0 && inFlight >= maxConcurrent) {
              if (isDebug) console.log(`[Bashful] At capacity (${inFlight}/${maxConcurrent}), rejecting`);
              return new Response(
                JSON.stringify({ error: 'Too Many Requests', reason: `at capacity (${maxConcurrent} concurrent executions)` }),
                { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Retry-After': '1' } }
              );
            }

            const cliArgs = buildCLIArgs(payload, schema);
            if (isDebug) console.log(`[Bashful] Executing: ${cmdName} ${cliArgs.join(' ')}`);

            const proc = safeSpawn([cmdName, ...cliArgs], { stdout: 'pipe', stderr: 'pipe' });
            inFlight++;

            let timedOut = false;
            const timer = timeoutMs > 0
              ? setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs)
              : undefined;

            // A client that hangs up must not leave the command running forever.
            const onAbort = () => proc.kill();
            req.signal.addEventListener('abort', onAbort);

            const release = () => {
              clearTimeout(timer);
              req.signal.removeEventListener('abort', onAbort);
              inFlight--;
            };
            proc.exited.then(release, release);

            // A JSON client wants the exit code, which a stream cannot carry —
            // the status line is long gone by the time the process exits. So
            // buffer for them, and keep streaming for everyone else.
            if (wantsJson(req.headers.get('accept'))) {
              const [stdout, stderr] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
              ]);
              const exitCode = await proc.exited;
              return new Response(
                JSON.stringify({ command: cmdName, args: cliArgs, exitCode, stdout, stderr, timedOut }),
                {
                  status: 200,
                  headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                }
              );
            }

            // Merge stdout + stderr into a single stream so error output (and
            // tools that write to stderr) is visible, while preserving streaming.
            const merged = new ReadableStream<Uint8Array>({
              start(controller) {
                const pump = async (stream: ReadableStream<Uint8Array> | undefined | null) => {
                  if (!stream) return;
                  const reader = stream.getReader();
                  for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    controller.enqueue(value);
                  }
                };
                Promise.all([pump(proc.stdout), pump(proc.stderr)])
                  .then(async () => {
                    if (timedOut) {
                      controller.enqueue(new TextEncoder().encode(`\n[Bashful] Killed after ${timeoutMs / 1000}s timeout.\n`));
                    }
                    controller.close();
                  })
                  .catch((err) => controller.error(err));
              }
            });

            return new Response(merged, {
              headers: { ...corsHeaders, 'Content-Type': 'text/plain' }
            });
          } catch (e: any) {
            const isPayloadError = e instanceof PayloadError;
            if (isDebug) console.log(`[Bashful] ${isPayloadError ? 'Rejected payload' : 'Error'}: ${e.message}`);
            return new Response(
              JSON.stringify({ error: isPayloadError ? 'Bad Request' : 'Internal Error', reason: e.message }),
              {
                status: isPayloadError ? 400 : 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
              }
            );
          }
        }
      }

      const routes = commandNames.map(n => `  - POST /${n}  |  GET /${n}/schema`).join('\n');
      return new Response(`Not Found.\n\nAvailable endpoints:\n${routes}`, {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'text/plain' }
      });
    }
  });

  if (isDebug) {
    console.log(`[Bashful] Server listening on port ${server.port}`);
    for (const { name } of commands) {
      console.log(`  - UI:     GET  http://${HOST}:${server.port}/`);
      console.log(`  - Schema: GET  http://${HOST}:${server.port}/${name}/schema`);
      console.log(`  - Exec:   POST http://${HOST}:${server.port}/${name}`);
    }
    console.timeEnd('Bashful Startup');
  }
}
