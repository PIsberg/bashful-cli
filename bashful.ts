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

const SCHEMA_REGEX = /^\s*(?:(-[a-zA-Z0-9]),?\s+)?(--[a-zA-Z0-9-]+|\/[a-zA-Z0-9]+)\s+(?:<([^>]+)>|\[([^\]]+)\]|([A-Z0-9_]{2,}))?\s+(.*)$/gm;

/** Parse --help text into a flag schema using the "Bashful Regex". */
export function parseSchema(helpText: string): Record<string, any> {
  const schema: Record<string, any> = {};
  for (const match of helpText.matchAll(SCHEMA_REGEX)) {
    const [, shortFlag, longFlag, type1, type2, type3, description] = match;
    const type = type1 || type2 || type3 || 'boolean';
    schema[longFlag.replace(/^--/, '')] = { shortFlag, longFlag, type, description: description.trim() };
  }
  return schema;
}

/** Translate a JSON payload into a CLI argument array, using the schema for flag lookup. */
export function buildCLIArgs(payload: Record<string, any>, schema: Record<string, any>): string[] {
  const cliArgs: string[] = [];

  if (Array.isArray(payload._args)) {
    cliArgs.push(...payload._args);
  } else if (typeof payload._args === 'string') {
    cliArgs.push(payload._args);
  }

  for (const [key, value] of Object.entries(payload)) {
    if (key === '_args') continue;
    const flagDef = schema[key];
    if (flagDef) {
      if (flagDef.type === 'boolean' || value === 'true' || value === true) {
        if (value !== 'false' && value !== false) cliArgs.push(flagDef.longFlag);
      } else {
        cliArgs.push(flagDef.longFlag, String(value));
      }
    } else if (key.length === 1) {
      if (value === 'true' || value === true) cliArgs.push(`-${key}`);
      else if (value !== 'false' && value !== false) cliArgs.push(`-${key}`, String(value));
    } else {
      if (value === 'true' || value === true) cliArgs.push(`--${key}`);
      else if (value !== 'false' && value !== false) cliArgs.push(`--${key}`, String(value));
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
  };
}

/** The flag names a payload would actually emit — omits flags that build to nothing. */
export function extractFlagNames(payload: Record<string, any>): string[] {
  const names: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (key === '_args') {
      const nonEmpty = Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.length > 0;
      if (nonEmpty) names.push('_args');
      continue;
    }
    // buildCLIArgs drops false-valued flags, so they can't reach the shell.
    if (value === false || value === 'false') continue;
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

/** Full check for one request: the command, then the flags it carries. */
export function authorizeRequest(command: string, payload: Record<string, any>, config: BashfulConfig): Decision {
  const cmdDecision = authorizeCommand(command, config);
  if (!cmdDecision.allowed) return cmdDecision;
  return authorizeFlags(command, extractFlagNames(payload), config);
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

/** Pull `--config <path>` (and `--config=<path>`) out of the arg list. */
export function extractConfigPath(args: string[]): { configPath?: string; rest: string[] } {
  const rest: string[] = [];
  let configPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--config') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('-')) throw new Error("--config requires a file path");
      configPath = next;
      i++;
    } else if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length);
      if (!value) throw new Error("--config requires a file path");
      configPath = value;
    } else {
      rest.push(arg);
    }
  }
  return { configPath, rest };
}

const DEFAULT_CONFIG_FILE = 'bashful.config.json';

if (import.meta.main) {
  const isDebug = process.argv.includes('--debug');
  if (isDebug) console.time('Bashful Startup');

  const rawArgs = process.argv.slice(2).filter(arg => arg !== '--debug');

  let configPath: string | undefined;
  let args: string[];
  try {
    ({ configPath, rest: args } = extractConfigPath(rawArgs));
  } catch (err: any) {
    console.error(`[Bashful] ${err.message}`);
    process.exit(1);
  }

  if (args.length === 0) {
    console.error('Usage: bashful [--debug] [--config <file>] <command> [args...] [\\| <command2> [args...] ...]');
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
                if (isBool) {
                    const label = document.createElement('label');
                    label.className = 'checkbox-label';
                    const input = document.createElement('input');
                    input.type = 'checkbox';
                    input.name = key;
                    label.appendChild(input);
                    label.appendChild(document.createTextNode('--' + key + (def.shortFlag ? ' (' + def.shortFlag + ')' : '')));
                    const badge = document.createElement('span');
                    badge.className = 'badge';
                    badge.textContent = def.type;
                    label.appendChild(badge);
                    div.appendChild(label);
                } else {
                    const label = document.createElement('label');
                    label.textContent = '--' + key + (def.shortFlag ? ' (' + def.shortFlag + ')' : '');
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

  const server = Bun.serve({
    port: PORT,
    hostname: HOST,
    async fetch(req) {
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      };

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
          try {
            let payload: Record<string, any> = {};
            if (req.method === 'POST') {
              payload = await req.json().catch(() => ({}));
            } else {
              const qs = searchStart !== -1 ? fullPath.slice(searchStart) : '';
              for (const [key, value] of new URLSearchParams(qs).entries()) {
                payload[key] = value;
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

            const cliArgs = buildCLIArgs(payload, schema);
            if (isDebug) console.log(`[Bashful] Executing: ${cmdName} ${cliArgs.join(' ')}`);

            const proc = safeSpawn([cmdName, ...cliArgs], { stdout: 'pipe', stderr: 'pipe' });

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
                  .then(() => controller.close())
                  .catch((err) => controller.error(err));
              }
            });

            return new Response(merged, {
              headers: { ...corsHeaders, 'Content-Type': 'text/plain' }
            });
          } catch (e: any) {
            return new Response(JSON.stringify({ error: e.message }), {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
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
