const isDebug = process.argv.includes('--debug');
if (isDebug) console.time('Bashful Startup');

const args = process.argv.slice(2).filter(arg => arg !== '--debug');
if (args.length === 0) {
  console.error('Usage: bashful [--debug] <command> [args...]');
  console.error('Example: bashful --debug pipe ping --help');
  process.exit(1);
}

let command = args[0];
let helpText = '';

if (command === 'pipe') {
    command = args[1];
    const proc = Bun.spawnSync(args.slice(1), { stdout: 'pipe', stderr: 'pipe' });
    helpText = (proc.stdout?.toString() ?? '') + (proc.stderr?.toString() ?? '');
} else {
    const proc = Bun.spawnSync([command, '--help'], { stdout: 'pipe', stderr: 'pipe' });
    helpText = (proc.stdout?.toString() ?? '') + (proc.stderr?.toString() ?? '');
}

// The "Bashful" Regex Pattern
const regex = /^\s*(?:(-[a-zA-Z0-9]),?\s+)?(--[a-zA-Z0-9-]+)\s+(?:<([^>]+)>|\[([^\]]+)\]|([A-Z0-9_]{2,}))?\s+(.*)$/gm;

const schema: Record<string, any> = {};

let match;
while ((match = regex.exec(helpText)) !== null) {
    const shortFlag = match[1];
    const longFlag = match[2];
    const type1 = match[3];
    const type2 = match[4];
    const type3 = match[5];
    const description = match[6];

    const type = type1 || type2 || type3 || 'boolean';
    
    schema[longFlag.replace(/^--/, '')] = {
        shortFlag,
        longFlag,
        type,
        description: description.trim()
    };
}

if (isDebug) console.log(`[Bashful] Parsed schema for '${command}':`, Object.keys(schema).length, 'flags found.');

const swaggerHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bashful UI - ${command}</title>
    <style>
        body { font-family: system-ui, -apple-system, sans-serif; max-width: 900px; margin: 0 auto; padding: 2rem; background: #f3f4f6; color: #1f2937; }
        h1 { border-bottom: 2px solid #e5e7eb; padding-bottom: 0.5rem; margin-bottom: 2rem; }
        .card { background: white; padding: 1.5rem; border-radius: 0.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 1.5rem; }
        .form-group { margin-bottom: 1rem; padding-bottom: 1rem; border-bottom: 1px solid #f3f4f6; }
        .form-group:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
        label { display: block; font-weight: 600; margin-bottom: 0.25rem; }
        .desc { font-size: 0.875rem; color: #6b7280; margin-bottom: 0.5rem; }
        input[type="text"] { width: 100%; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 0.25rem; box-sizing: border-box; font-family: monospace; }
        input[type="checkbox"] { margin-right: 0.5rem; transform: scale(1.2); }
        .checkbox-label { display: flex; align-items: center; font-weight: 600; cursor: pointer; }
        button { background: #2563eb; color: white; border: none; padding: 0.75rem 1.5rem; border-radius: 0.25rem; cursor: pointer; font-weight: bold; font-size: 1rem; width: 100%; transition: background 0.2s; }
        button:hover { background: #1d4ed8; }
        pre { background: #111827; color: #e5e7eb; padding: 1rem; border-radius: 0.5rem; overflow-x: auto; white-space: pre-wrap; font-family: monospace; min-height: 100px; }
        .badge { display: inline-block; padding: 0.1rem 0.4rem; background: #e5e7eb; color: #374151; border-radius: 0.25rem; font-size: 0.75rem; font-family: monospace; margin-left: 0.5rem; }
    </style>
</head>
<body>
    <h1>Bashful UI: <code>${command}</code></h1>
    <div class="card">
        <form id="api-form">
            <div class="form-group">
                <label>Positional Arguments (_args)</label>
                <div class="desc">Arguments passed without flags (space separated)</div>
                <input type="text" id="input-_args" name="_args" placeholder="e.g. http://example.com">
            </div>
            <div id="flags-container"></div>
            <div style="margin-top: 1.5rem;">
                <button type="submit">Execute Command</button>
            </div>
        </form>
    </div>
    <div class="card">
        <h2 style="margin-top: 0;">Output</h2>
        <pre id="output">Ready.</pre>
    </div>

    <script>
        async function init() {
            const res = await fetch('/${command}/schema');
            const schema = await res.json();
            const container = document.getElementById('flags-container');
            
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
                
                container.appendChild(div);
            }
        }

        document.getElementById('api-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const outputEl = document.getElementById('output');
            const btn = e.target.querySelector('button');
            
            outputEl.textContent = 'Executing...';
            btn.disabled = true;
            btn.textContent = 'Running...';
            
            const payload = {};
            const formData = new FormData(e.target);
            
            const argsVal = formData.get('_args');
            if (argsVal) {
                payload._args = argsVal.split(' ').filter(Boolean);
            }

            const checkboxes = e.target.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach(cb => {
                if (cb.checked) payload[cb.name] = true;
            });

            const textInputs = e.target.querySelectorAll('input[type="text"]');
            textInputs.forEach(input => {
                if (input.name !== '_args' && input.value.trim() !== '') {
                    payload[input.name] = input.value.trim();
                }
            });

            try {
                const res = await fetch('/${command}', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const text = await res.text();
                outputEl.textContent = text;
            } catch (err) {
                outputEl.textContent = 'Error: ' + err.message;
            } finally {
                btn.disabled = false;
                btn.textContent = 'Execute Command';
            }
        });

        init();
    </script>
</body>
</html>`;

const PORT = 3000;

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

        const url = new URL(req.url);

        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/docs' || url.pathname === '/ui')) {
            return new Response(swaggerHtml, {
                headers: { ...corsHeaders, 'Content-Type': 'text/html' }
            });
        }

        if (req.method === 'GET' && url.pathname === `/${command}/schema`) {
            return new Response(JSON.stringify(schema, null, 2), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        if ((req.method === 'POST' || req.method === 'GET') && url.pathname === `/${command}`) {
            try {
                let payload: Record<string, any> = {};
                
                if (req.method === 'POST') {
                    const text = await req.text();
                    if (text) {
                        payload = JSON.parse(text);
                    }
                } else if (req.method === 'GET') {
                    for (const [key, value] of url.searchParams.entries()) {
                        payload[key] = value;
                    }
                }

                const cliArgs: string[] = [];
                
                if (payload._args && Array.isArray(payload._args)) {
                    cliArgs.push(...payload._args);
                } else if (payload._args && typeof payload._args === 'string') {
                    cliArgs.push(payload._args);
                }

                for (const [key, value] of Object.entries(payload)) {
                    if (key === '_args') continue;
                    
                    const flagDef = schema[key];
                    if (flagDef) {
                        if (flagDef.type === 'boolean' || value === 'true' || value === true) {
                            if (value !== 'false' && value !== false) {
                                cliArgs.push(flagDef.longFlag);
                            }
                        } else {
                            cliArgs.push(flagDef.longFlag, String(value));
                        }
                    } else if (key.length === 1) {
                        if (value === 'true' || value === true) {
                            cliArgs.push(`-${key}`);
                        } else if (value !== 'false' && value !== false) {
                            cliArgs.push(`-${key}`, String(value));
                        }
                    } else {
                        if (value === 'true' || value === true) {
                            cliArgs.push(`--${key}`);
                        } else if (value !== 'false' && value !== false) {
                            cliArgs.push(`--${key}`, String(value));
                        }
                    }
                }

                if (isDebug) console.log(`[Bashful] Executing: ${command} ${cliArgs.join(' ')}`);
                
                const proc = Bun.spawn([command, ...cliArgs], {
                    stdout: "pipe",
                    stderr: "pipe",
                });

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

        return new Response(`Not Found. Try POST /${command} or GET /${command}/schema`, {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'text/plain' }
        });
    }
});

if (isDebug) {
    console.log(`[Bashful] Server listening on port ${server.port}`);
    console.log(`[Bashful] REST API ready for '${command}'`);
    console.log(`  - UI:     GET http://localhost:${server.port}/`);
    console.log(`  - Schema: GET http://localhost:${server.port}/${command}/schema`);
    console.log(`  - Exec:   POST http://localhost:${server.port}/${command}`);
    console.timeEnd('Bashful Startup');
}
