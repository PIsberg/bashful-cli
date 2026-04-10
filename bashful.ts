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

if (import.meta.main) {
  const isDebug = process.argv.includes('--debug');
  if (isDebug) console.time('Bashful Startup');

  const args = process.argv.slice(2).filter(arg => arg !== '--debug');
  if (args.length === 0) {
    console.error('Usage: bashful [--debug] <command> [args...] [\\| <command2> [args...] ...]');
    console.error('Example: bashful curl \\| wget');
    console.error('Example: bashful curl --help \\| wget --help');
    process.exit(1);
  }

  const segments = splitSegments(args);

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
  const commandMap = new Map(commands.map(c => [c.name, c.schema]));
  const serializedSchemas = new Map(commands.map(c => [c.name, JSON.stringify(c.schema, null, 2)]));

  const server = Bun.serve({
    port: PORT,
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

            const cliArgs = buildCLIArgs(payload, schema);
            if (isDebug) console.log(`[Bashful] Executing: ${cmdName} ${cliArgs.join(' ')}`);

            const proc = safeSpawn([cmdName, ...cliArgs], { stdout: 'pipe', stderr: 'pipe' });
            return new Response(proc.stdout, {
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
      console.log(`  - UI:     GET  http://localhost:${server.port}/`);
      console.log(`  - Schema: GET  http://localhost:${server.port}/${name}/schema`);
      console.log(`  - Exec:   POST http://localhost:${server.port}/${name}`);
    }
    console.timeEnd('Bashful Startup');
  }
}
