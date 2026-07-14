import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  splitSegments,
  parseSchema,
  buildCLIArgs,
  parseConfig,
  normalizeConfig,
  extractOptions,
  parseHostHeader,
  isLoopbackHost,
  isAllowedHost,
  buildCorsHeaders,
  isJsonContentType,
  extractFlagNames,
  effectiveFlagPolicy,
  authorizeCommand,
  authorizeFlags,
  authorizeRequest,
  filterSchema,
  DEFAULT_CONFIG,
  type BashfulConfig,
} from './bashful';

// ── splitSegments ─────────────────────────────────────────────────────────────

describe('splitSegments', () => {
  test('single command', () => {
    expect(splitSegments(['curl'])).toEqual([['curl']]);
  });

  test('single command with extra args (pipe mode)', () => {
    expect(splitSegments(['curl', '--help'])).toEqual([['curl', '--help']]);
  });

  test('escaped pipe symbol evaluates correctly (Windows compat)', () => {
    expect(splitSegments(['curl', '\\|', 'wget'])).toEqual([['curl'], ['wget']]);
  });

  test('two commands separated by |', () => {
    expect(splitSegments(['curl', '|', 'wget'])).toEqual([['curl'], ['wget']]);
  });

  test('three commands separated by |', () => {
    expect(splitSegments(['curl', '|', 'wget', '|', 'ping'])).toEqual([
      ['curl'], ['wget'], ['ping']
    ]);
  });

  test('pipe mode segments with multiple words', () => {
    expect(splitSegments(['curl', '--help', '|', 'wget', '--help'])).toEqual([
      ['curl', '--help'], ['wget', '--help']
    ]);
  });

  test('leading | is ignored', () => {
    expect(splitSegments(['|', 'curl'])).toEqual([['curl']]);
  });

  test('trailing | is ignored', () => {
    expect(splitSegments(['curl', '|'])).toEqual([['curl']]);
  });

  test('empty args returns empty array', () => {
    expect(splitSegments([])).toEqual([]);
  });
});

// ── parseSchema ───────────────────────────────────────────────────────────────

describe('parseSchema', () => {
  test('returns empty schema for empty help text', () => {
    expect(parseSchema('')).toEqual({});
  });

  test('returns empty schema for text with no flags', () => {
    expect(parseSchema('Usage: curl [options] <url>\nTransfer data from a server.')).toEqual({});
  });

  test('parses a boolean long flag', () => {
    const schema = parseSchema('  --silent               Silent mode');
    expect(schema['silent']).toMatchObject({
      longFlag: '--silent',
      type: 'boolean',
      description: 'Silent mode',
    });
  });

  test('parses a long flag with short flag', () => {
    const schema = parseSchema('  -s, --silent           Silent mode');
    expect(schema['silent']).toMatchObject({
      shortFlag: '-s',
      longFlag: '--silent',
      type: 'boolean',
    });
  });

  test('parses a flag with angle-bracket value type', () => {
    const schema = parseSchema('  -o, --output <file>    Write output to file');
    expect(schema['output']).toMatchObject({
      shortFlag: '-o',
      longFlag: '--output',
      type: 'file',
      description: 'Write output to file',
    });
  });

  test('parses a flag with bracket value type', () => {
    const schema = parseSchema('      --retry [num]     Retry count');
    expect(schema['retry']).toMatchObject({
      longFlag: '--retry',
      type: 'num',
    });
  });

  test('parses a flag with ALLCAPS value type', () => {
    const schema = parseSchema('      --connect-timeout SECONDS  Max time for connection');
    expect(schema['connect-timeout']).toMatchObject({
      longFlag: '--connect-timeout',
      type: 'SECONDS',
    });
  });

  test('parses multiple flags from realistic help text', () => {
    const helpText = `
Usage: curl [options...] <url>
  -s, --silent            Silent mode
  -o, --output <file>     Write to file instead of stdout
  -L, --location          Follow redirects
      --max-time SECONDS  Maximum time allowed
    `;
    const schema = parseSchema(helpText);
    expect(Object.keys(schema)).toEqual(
      expect.arrayContaining(['silent', 'output', 'location', 'max-time'])
    );
    expect(schema['silent'].type).toBe('boolean');
    expect(schema['output'].type).toBe('file');
    expect(schema['location'].type).toBe('boolean');
    expect(schema['max-time'].type).toBe('SECONDS');
  });

  test('trims trailing whitespace from descriptions', () => {
    const schema = parseSchema('  --verbose              Be verbose   ');
    expect(schema['verbose'].description).toBe('Be verbose');
  });
});

// ── buildCLIArgs ──────────────────────────────────────────────────────────────

const curlSchema = {
  silent:  { shortFlag: '-s', longFlag: '--silent',  type: 'boolean' },
  output:  { shortFlag: '-o', longFlag: '--output',  type: 'file'    },
  verbose: { shortFlag: '-v', longFlag: '--verbose', type: 'boolean' },
};

describe('buildCLIArgs', () => {
  test('empty payload returns empty array', () => {
    expect(buildCLIArgs({}, curlSchema)).toEqual([]);
  });

  test('_args as array', () => {
    expect(buildCLIArgs({ _args: ['http://example.com'] }, curlSchema))
      .toEqual(['http://example.com']);
  });

  test('_args as string', () => {
    expect(buildCLIArgs({ _args: 'http://example.com' }, curlSchema))
      .toEqual(['http://example.com']);
  });

  test('boolean flag set to true', () => {
    expect(buildCLIArgs({ silent: true }, curlSchema)).toContain('--silent');
  });

  test('boolean flag set to false is omitted', () => {
    expect(buildCLIArgs({ silent: false }, curlSchema)).not.toContain('--silent');
  });

  test('boolean flag set to string "false" is omitted', () => {
    expect(buildCLIArgs({ silent: 'false' }, curlSchema)).not.toContain('--silent');
  });

  test('value flag appends the value after the long flag', () => {
    const args = buildCLIArgs({ output: 'result.html' }, curlSchema);
    expect(args).toEqual(['--output', 'result.html']);
  });

  test('multiple flags combined with _args', () => {
    const args = buildCLIArgs(
      { _args: ['http://example.com'], silent: true, output: 'out.html' },
      curlSchema
    );
    expect(args[0]).toBe('http://example.com');
    expect(args).toContain('--silent');
    expect(args).toContain('--output');
    expect(args).toContain('out.html');
  });

  test('unknown single-char key treated as short flag (boolean)', () => {
    const args = buildCLIArgs({ v: true }, {});
    expect(args).toContain('-v');
  });

  test('unknown single-char key treated as short flag (value)', () => {
    const args = buildCLIArgs({ x: 'GET' }, {});
    expect(args).toEqual(['-x', 'GET']);
  });

  test('unknown multi-char key treated as long flag (boolean)', () => {
    const args = buildCLIArgs({ verbose: true }, {});
    expect(args).toContain('--verbose');
  });

  test('unknown multi-char key treated as long flag (value)', () => {
    const args = buildCLIArgs({ timeout: '30' }, {});
    expect(args).toEqual(['--timeout', '30']);
  });

  test('unknown single-char flag with false value is omitted', () => {
    expect(buildCLIArgs({ v: false }, {})).toEqual([]);
  });

  test('unknown multi-char flag with false value is omitted', () => {
    expect(buildCLIArgs({ verbose: false }, {})).toEqual([]);
  });
});

// ── Config parsing ────────────────────────────────────────────────────────────

describe('normalizeConfig / parseConfig', () => {
  test('null config yields the permissive default', () => {
    expect(normalizeConfig(null)).toEqual(DEFAULT_CONFIG);
  });

  test('defaults to blacklist mode', () => {
    expect(normalizeConfig({}).mode).toBe('blacklist');
  });

  test('parses a full config', () => {
    const config = parseConfig(JSON.stringify({
      mode: 'whitelist',
      commands: { allow: ['curl'], deny: ['rm'] },
      flags: { curl: { allow: ['silent'], deny: ['config'], denyCombinations: [['output', 'upload-file']] } },
    }));
    expect(config.mode).toBe('whitelist');
    expect(config.commands.allow).toEqual(['curl']);
    expect(config.flags['curl']!.denyCombinations).toEqual([['output', 'upload-file']]);
  });

  test('rejects an unknown mode', () => {
    expect(() => normalizeConfig({ mode: 'allowlist' })).toThrow(/mode/);
  });

  test('rejects a non-object root', () => {
    expect(() => normalizeConfig(['curl'])).toThrow(/root/);
  });

  test('rejects a non-string entry in a command list', () => {
    expect(() => normalizeConfig({ commands: { deny: ['rm', 7] } })).toThrow(/commands.deny/);
  });

  test('rejects combinations that are not arrays of arrays', () => {
    expect(() => normalizeConfig({ flags: { curl: { denyCombinations: ['output'] } } }))
      .toThrow(/denyCombinations/);
  });

  test('rejects invalid JSON', () => {
    expect(() => parseConfig('{ not json')).toThrow(/invalid JSON/);
  });
});

// ── extractOptions ────────────────────────────────────────────────────────────

describe('extractOptions', () => {
  test('no options leaves args untouched, and GET exec is off by default', () => {
    const opts = extractOptions(['curl', '|', 'wget']);
    expect(opts.rest).toEqual(['curl', '|', 'wget']);
    expect(opts.allowGet).toBe(false);
    expect(opts.allowOrigin).toBeUndefined();
    expect(opts.configPath).toBeUndefined();
  });

  test('--config <path> is removed from args', () => {
    const opts = extractOptions(['--config', 'policy.json', 'curl']);
    expect(opts.configPath).toBe('policy.json');
    expect(opts.rest).toEqual(['curl']);
  });

  test('--config=<path> is removed from args', () => {
    expect(extractOptions(['--config=policy.json', 'curl']).configPath).toBe('policy.json');
  });

  test('--allow-get is a boolean switch', () => {
    const opts = extractOptions(['--allow-get', 'curl']);
    expect(opts.allowGet).toBe(true);
    expect(opts.rest).toEqual(['curl']);
  });

  test('--allow-origin takes a value in both spellings', () => {
    expect(extractOptions(['--allow-origin', 'https://a.test', 'curl']).allowOrigin).toBe('https://a.test');
    expect(extractOptions(['--allow-origin=https://a.test', 'curl']).allowOrigin).toBe('https://a.test');
  });

  test('all options combine, leaving only the command', () => {
    const opts = extractOptions(['--config', 'p.json', '--allow-get', '--allow-origin=https://a.test', 'curl', '|', 'wget']);
    expect(opts).toMatchObject({ configPath: 'p.json', allowGet: true, allowOrigin: 'https://a.test' });
    expect(opts.rest).toEqual(['curl', '|', 'wget']);
  });

  test('an option with no value throws', () => {
    expect(() => extractOptions(['--config'])).toThrow(/--config requires a value/);
    expect(() => extractOptions(['--allow-origin'])).toThrow(/--allow-origin requires a value/);
  });

  test('an option followed by a flag throws', () => {
    expect(() => extractOptions(['--config', '--allow-get', 'curl'])).toThrow(/requires a value/);
  });
});

// ── Request hardening ─────────────────────────────────────────────────────────

describe('parseHostHeader', () => {
  test('strips the port', () => {
    expect(parseHostHeader('localhost:3000')).toBe('localhost');
    expect(parseHostHeader('127.0.0.1:3000')).toBe('127.0.0.1');
  });

  test('handles a bare hostname', () => {
    expect(parseHostHeader('localhost')).toBe('localhost');
  });

  test('handles bracketed IPv6', () => {
    expect(parseHostHeader('[::1]:3000')).toBe('::1');
  });

  test('lowercases', () => {
    expect(parseHostHeader('LOCALHOST:3000')).toBe('localhost');
  });

  test('returns null for a missing or empty header', () => {
    expect(parseHostHeader(null)).toBeNull();
    expect(parseHostHeader('  ')).toBeNull();
  });
});

describe('isLoopbackHost', () => {
  test('accepts loopback names and addresses', () => {
    for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '::1']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  test('rejects everything else', () => {
    for (const host of ['evil.example', '0.0.0.0', '192.168.1.5', '127.0.0.1.evil.example']) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe('isAllowedHost', () => {
  test('accepts a loopback Host when bound to loopback', () => {
    expect(isAllowedHost('localhost:3000', '127.0.0.1')).toBe(true);
  });

  test('rejects a foreign Host when bound to loopback (DNS rebinding)', () => {
    // The name resolves to 127.0.0.1, but the Host header gives the attacker away.
    expect(isAllowedHost('evil.example:3000', '127.0.0.1')).toBe(false);
  });

  test('rejects a missing Host header when bound to loopback', () => {
    expect(isAllowedHost(null, '127.0.0.1')).toBe(false);
  });

  test('accepts any Host when the operator bound a public interface', () => {
    expect(isAllowedHost('bashful.internal:3000', '0.0.0.0')).toBe(true);
  });
});

describe('buildCorsHeaders', () => {
  test('sends no CORS headers by default — this is the point', () => {
    expect(buildCorsHeaders('https://evil.example', undefined)).toEqual({});
  });

  test('echoes a matching configured origin', () => {
    const headers = buildCorsHeaders('https://app.test', 'https://app.test');
    expect(headers['Access-Control-Allow-Origin']).toBe('https://app.test');
    expect(headers['Vary']).toBe('Origin');
  });

  test('sends nothing for an origin that does not match', () => {
    expect(buildCorsHeaders('https://evil.example', 'https://app.test')).toEqual({});
  });

  test("'*' is honoured, but only when explicitly configured", () => {
    expect(buildCorsHeaders('https://evil.example', '*')['Access-Control-Allow-Origin']).toBe('*');
  });
});

describe('isJsonContentType', () => {
  test('accepts application/json with or without parameters', () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
    expect(isJsonContentType('APPLICATION/JSON')).toBe(true);
  });

  test('rejects the content types a cross-origin form/simple request can set', () => {
    expect(isJsonContentType('text/plain')).toBe(false);
    expect(isJsonContentType('application/x-www-form-urlencoded')).toBe(false);
    expect(isJsonContentType('multipart/form-data')).toBe(false);
    expect(isJsonContentType(null)).toBe(false);
  });
});

// ── extractFlagNames ──────────────────────────────────────────────────────────

describe('extractFlagNames', () => {
  test('lists flag keys', () => {
    expect(extractFlagNames({ silent: true, output: 'out.html' })).toEqual(['silent', 'output']);
  });

  test('omits false-valued flags (they never reach the shell)', () => {
    expect(extractFlagNames({ silent: false, verbose: 'false', output: 'o' })).toEqual(['output']);
  });

  test('counts non-empty _args as a governable flag name', () => {
    expect(extractFlagNames({ _args: ['http://example.com'] })).toEqual(['_args']);
    expect(extractFlagNames({ _args: 'http://example.com' })).toEqual(['_args']);
  });

  test('ignores empty _args', () => {
    expect(extractFlagNames({ _args: [] })).toEqual([]);
    expect(extractFlagNames({ _args: '' })).toEqual([]);
  });
});

// ── effectiveFlagPolicy ───────────────────────────────────────────────────────

describe('effectiveFlagPolicy', () => {
  test('returns an empty policy when nothing is configured', () => {
    expect(effectiveFlagPolicy('curl', DEFAULT_CONFIG)).toEqual({});
  });

  test('merges the wildcard policy with the command policy', () => {
    const config = normalizeConfig({
      flags: { '*': { deny: ['config'] }, curl: { deny: ['proxy'], allow: ['silent'] } },
    });
    const policy = effectiveFlagPolicy('curl', config);
    expect(policy.deny).toEqual(['config', 'proxy']);
    expect(policy.allow).toEqual(['silent']);
  });

  test('a command with no policy of its own still inherits the wildcard', () => {
    const config = normalizeConfig({ flags: { '*': { deny: ['config'] } } });
    expect(effectiveFlagPolicy('wget', config).deny).toEqual(['config']);
  });
});

// ── authorizeCommand ──────────────────────────────────────────────────────────

describe('authorizeCommand', () => {
  test('allows anything with no config', () => {
    expect(authorizeCommand('rm', DEFAULT_CONFIG)).toEqual({ allowed: true });
  });

  test('blacklist: denied command is rejected', () => {
    const config = normalizeConfig({ commands: { deny: ['rm'] } });
    const decision = authorizeCommand('rm', config);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toMatch(/denied/);
  });

  test('blacklist: everything else is allowed', () => {
    const config = normalizeConfig({ commands: { deny: ['rm'] } });
    expect(authorizeCommand('curl', config).allowed).toBe(true);
  });

  test('whitelist: only listed commands are allowed', () => {
    const config = normalizeConfig({ mode: 'whitelist', commands: { allow: ['curl'] } });
    expect(authorizeCommand('curl', config).allowed).toBe(true);
    expect(authorizeCommand('wget', config).allowed).toBe(false);
  });

  test('whitelist with no allow list denies everything', () => {
    expect(authorizeCommand('curl', normalizeConfig({ mode: 'whitelist' })).allowed).toBe(false);
  });

  test('deny beats allow', () => {
    const config = normalizeConfig({ mode: 'whitelist', commands: { allow: ['curl'], deny: ['curl'] } });
    expect(authorizeCommand('curl', config).allowed).toBe(false);
  });

  test("'*' in the allow list permits any command", () => {
    const config = normalizeConfig({ mode: 'whitelist', commands: { allow: ['*'] } });
    expect(authorizeCommand('anything', config).allowed).toBe(true);
  });
});

// ── authorizeFlags ────────────────────────────────────────────────────────────

describe('authorizeFlags', () => {
  test('allows any flag with no config', () => {
    expect(authorizeFlags('curl', ['silent', 'output'], DEFAULT_CONFIG).allowed).toBe(true);
  });

  test('denies a blacklisted flag', () => {
    const config = normalizeConfig({ flags: { curl: { deny: ['config'] } } });
    const decision = authorizeFlags('curl', ['silent', 'config'], config);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain("flag 'config'");
  });

  test('a wildcard flag policy applies to every command', () => {
    const config = normalizeConfig({ flags: { '*': { deny: ['output'] } } });
    expect(authorizeFlags('wget', ['output'], config).allowed).toBe(false);
  });

  test('an allow list on a command implies whitelisting for that command', () => {
    const config = normalizeConfig({ flags: { curl: { allow: ['silent', '_args'] } } });
    expect(authorizeFlags('curl', ['silent', '_args'], config).allowed).toBe(true);
    expect(authorizeFlags('curl', ['silent', 'output'], config).allowed).toBe(false);
  });

  test('whitelist mode denies any flag when no allow list exists', () => {
    const config = normalizeConfig({ mode: 'whitelist', commands: { allow: ['curl'] } });
    expect(authorizeFlags('curl', ['silent'], config).allowed).toBe(false);
    expect(authorizeFlags('curl', [], config).allowed).toBe(true); // no flags, nothing to check
  });

  test('denyCombinations rejects only the full combination', () => {
    const config = normalizeConfig({
      flags: { curl: { denyCombinations: [['output', 'upload-file']] } },
    });
    expect(authorizeFlags('curl', ['output'], config).allowed).toBe(true);
    expect(authorizeFlags('curl', ['upload-file'], config).allowed).toBe(true);
    const decision = authorizeFlags('curl', ['output', 'upload-file', 'silent'], config);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain('combination');
  });

  test('allowCombinations requires the used flags to fit inside one combination', () => {
    const config = normalizeConfig({
      flags: { curl: { allowCombinations: [['silent', 'output'], ['verbose', '_args']] } },
    });
    expect(authorizeFlags('curl', ['silent'], config).allowed).toBe(true);
    expect(authorizeFlags('curl', ['silent', 'output'], config).allowed).toBe(true);
    expect(authorizeFlags('curl', ['verbose', '_args'], config).allowed).toBe(true);
    // Valid individually, but they span two different allowed combinations.
    expect(authorizeFlags('curl', ['silent', 'verbose'], config).allowed).toBe(false);
  });

  test('empty payload passes allowCombinations', () => {
    const config = normalizeConfig({ flags: { curl: { allowCombinations: [['silent']] } } });
    expect(authorizeFlags('curl', [], config).allowed).toBe(true);
  });

  test('deny beats allow for flags', () => {
    const config = normalizeConfig({ flags: { curl: { allow: ['output'], deny: ['output'] } } });
    expect(authorizeFlags('curl', ['output'], config).allowed).toBe(false);
  });
});

// ── authorizeRequest ──────────────────────────────────────────────────────────

describe('authorizeRequest', () => {
  const config: BashfulConfig = normalizeConfig({
    mode: 'whitelist',
    commands: { allow: ['curl'] },
    flags: { curl: { allow: ['silent', 'output', '_args'], denyCombinations: [['silent', 'output']] } },
  });

  test('allows a permitted command + payload', () => {
    expect(authorizeRequest('curl', { silent: true, _args: ['http://example.com'] }, config).allowed).toBe(true);
  });

  test('rejects a command outside the whitelist', () => {
    expect(authorizeRequest('wget', { silent: true }, config).allowed).toBe(false);
  });

  test('rejects a flag outside the whitelist', () => {
    expect(authorizeRequest('curl', { proxy: 'http://evil' }, config).allowed).toBe(false);
  });

  test('rejects a denied combination', () => {
    expect(authorizeRequest('curl', { silent: true, output: 'f' }, config).allowed).toBe(false);
  });

  test('a false-valued flag does not trip a combination rule', () => {
    // `silent: false` builds to nothing, so this is really just `--output f`.
    expect(authorizeRequest('curl', { silent: false, output: 'f' }, config).allowed).toBe(true);
  });
});

// ── filterSchema ──────────────────────────────────────────────────────────────

describe('filterSchema', () => {
  const schema = {
    silent: { longFlag: '--silent', type: 'boolean' },
    output: { longFlag: '--output', type: 'file' },
    config: { longFlag: '--config', type: 'file' },
  };

  test('returns the schema unchanged with no config', () => {
    expect(filterSchema('curl', schema, DEFAULT_CONFIG)).toEqual(schema);
  });

  test('hides denied flags', () => {
    const config = normalizeConfig({ flags: { curl: { deny: ['config'] } } });
    expect(Object.keys(filterSchema('curl', schema, config))).toEqual(['silent', 'output']);
  });

  test('whitelist mode hides everything not allowed', () => {
    const config = normalizeConfig({ mode: 'whitelist', flags: { curl: { allow: ['silent'] } } });
    expect(Object.keys(filterSchema('curl', schema, config))).toEqual(['silent']);
  });

  test('combination rules do not hide individually-valid flags', () => {
    const config = normalizeConfig({ flags: { curl: { denyCombinations: [['silent', 'output']] } } });
    expect(Object.keys(filterSchema('curl', schema, config))).toEqual(['silent', 'output', 'config']);
  });
});

// ── Integration Tests ────────────────────────────────────────────────────────

import { spawn } from 'bun';

describe('Integration: HTTP Server Routing', () => {
  let serverProcess: ReturnType<typeof spawn>;
  const PORT = 3005; // Use a specific port for testing
  const baseUrl = `http://localhost:${PORT}`;

  beforeAll(async () => {
    // Spawn the bashful server with a distinct port
    serverProcess = spawn(['bun', 'run', './bashful.ts', 'bun'], {
      env: { ...process.env, PORT: String(PORT) },
      stdout: 'ignore',
      stderr: 'ignore'
    });
    // Wait for the server to start handling requests
    await new Promise(r => setTimeout(r, 600));
  });

  afterAll(() => {
    if (serverProcess) serverProcess.kill();
  });

  test('GET / returns HTML UI', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('<!DOCTYPE html>');
    expect(text).toContain('Bashful UI');
  });

  test('GET /bun/schema returns JSON schema', async () => {
    const res = await fetch(`${baseUrl}/bun/schema`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json).toBe('object');
  });

  test('POST /bun executes command and returns output', async () => {
    const res = await fetch(`${baseUrl}/bun`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: true })
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    // output should look like a version number e.g. 1.0.0
    expect(text).toMatch(/\d+\.\d+\.\d+/);
  });

  test('GET /unknown returns 404', async () => {
    const res = await fetch(`${baseUrl}/unknown`);
    expect(res.status).toBe(404);
  });

  test('GET execution is refused by default (it is CSRF-able)', async () => {
    const res = await fetch(`${baseUrl}/bun?version=true`);
    expect(res.status).toBe(405);
    expect((await res.json() as { reason: string }).reason).toContain('--allow-get');
  });

  test('POST without a JSON content-type is refused', async () => {
    // A cross-origin "simple" request cannot set application/json, so requiring
    // it forces a preflight — which fails, because we send no CORS headers.
    const res = await fetch(`${baseUrl}/bun`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ version: true })
    });
    expect(res.status).toBe(415);
  });

  test('no CORS headers are sent by default', async () => {
    const res = await fetch(`${baseUrl}/bun`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ version: true })
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('a preflight from an unapproved origin gets no CORS headers', async () => {
    const res = await fetch(`${baseUrl}/bun`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' }
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('a foreign Host header is rejected (DNS rebinding)', async () => {
    const res = await fetch(`${baseUrl}/bun`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: 'evil.example' },
      body: JSON.stringify({ version: true })
    });
    expect(res.status).toBe(421);
  });

  test('with no config, nothing is blocked', async () => {
    const res = await fetch(`${baseUrl}/bun`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: true })
    });
    expect(res.status).toBe(200);
  });

  test('exec endpoint surfaces stderr output (not just stdout)', async () => {
    // `bun --unknown-flag-xyz` fails and writes its diagnostic to stderr.
    // Previously only stdout was returned, so this came back empty.
    const res = await fetch(`${baseUrl}/bun`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _args: ['--this-flag-does-not-exist-xyz'] })
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.trim().length).toBeGreaterThan(0);
  });
});

// ── Integration: policy enforcement ──────────────────────────────────────────

import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Integration: config enforcement', () => {
  let serverProcess: ReturnType<typeof spawn>;
  const PORT = 3006;
  const baseUrl = `http://localhost:${PORT}`;
  const configPath = join(tmpdir(), 'bashful-test-policy.json');

  beforeAll(async () => {
    await Bun.write(configPath, JSON.stringify({
      mode: 'blacklist',
      commands: { deny: ['rm'] },
      flags: {
        bun: {
          deny: ['eval'],
          denyCombinations: [['version', 'revision']],
        },
      },
    }));

    // --allow-get so the query-param path can be policy-tested too.
    serverProcess = spawn(['bun', 'run', './bashful.ts', '--config', configPath, '--allow-get', 'bun'], {
      env: { ...process.env, PORT: String(PORT) },
      stdout: 'ignore',
      stderr: 'ignore'
    });
    await new Promise(r => setTimeout(r, 600));
  });

  afterAll(() => {
    if (serverProcess) serverProcess.kill();
  });

  const post = (body: unknown) => fetch(`${baseUrl}/bun`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  test('an allowed payload still executes', async () => {
    const res = await post({ version: true });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/\d+\.\d+\.\d+/);
  });

  test('a denied flag returns 403 with a reason', async () => {
    const res = await post({ eval: '1+1' });
    expect(res.status).toBe(403);
    const json = await res.json() as { error: string; reason: string };
    expect(json.error).toBe('Forbidden');
    expect(json.reason).toContain("flag 'eval'");
  });

  test('a denied flag combination returns 403', async () => {
    const res = await post({ version: true, revision: true });
    expect(res.status).toBe(403);
    expect((await res.json() as { reason: string }).reason).toContain('combination');
  });

  test('either flag of a denied combination is fine on its own', async () => {
    expect((await post({ revision: true })).status).toBe(200);
  });

  test('a denied flag is also blocked via GET query params', async () => {
    const res = await fetch(`${baseUrl}/bun?eval=1%2B1`);
    expect(res.status).toBe(403);
  });

  test('refuses to start when wrapping a denied command', async () => {
    const proc = spawn(['bun', 'run', './bashful.ts', '--config', configPath, 'rm'], {
      env: { ...process.env, PORT: '3007' },
      stdout: 'ignore',
      stderr: 'pipe'
    });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(1);
    expect(stderr).toContain('Refusing to wrap');
  });

  test('exits when the named config file does not exist', async () => {
    const proc = spawn(['bun', 'run', './bashful.ts', '--config', 'no-such-file.json', 'bun'], {
      env: { ...process.env, PORT: '3008' },
      stdout: 'ignore',
      stderr: 'pipe'
    });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(1);
    expect(stderr).toContain('Config file not found');
  });
});

describe('Integration: opt-in relaxations', () => {
  let serverProcess: ReturnType<typeof spawn>;
  const PORT = 3010;
  const baseUrl = `http://localhost:${PORT}`;
  const ORIGIN = 'https://app.test';

  beforeAll(async () => {
    serverProcess = spawn(
      ['bun', 'run', './bashful.ts', '--allow-get', '--allow-origin', ORIGIN, 'bun'],
      { env: { ...process.env, PORT: String(PORT) }, stdout: 'ignore', stderr: 'ignore' }
    );
    await new Promise(r => setTimeout(r, 600));
  });

  afterAll(() => {
    if (serverProcess) serverProcess.kill();
  });

  test('--allow-get re-enables query-param execution', async () => {
    const res = await fetch(`${baseUrl}/bun?version=true`);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/\d+\.\d+\.\d+/);
  });

  test('--allow-origin echoes only the configured origin', async () => {
    const allowed = await fetch(`${baseUrl}/bun?version=true`, { headers: { Origin: ORIGIN } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe(ORIGIN);

    const denied = await fetch(`${baseUrl}/bun?version=true`, { headers: { Origin: 'https://evil.example' } });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('the Host check still applies', async () => {
    const res = await fetch(`${baseUrl}/bun?version=true`, { headers: { Host: 'evil.example' } });
    expect(res.status).toBe(421);
  });
});

describe('Integration: whitelist mode', () => {
  let serverProcess: ReturnType<typeof spawn>;
  const PORT = 3009;
  const baseUrl = `http://localhost:${PORT}`;
  const configPath = join(tmpdir(), 'bashful-test-whitelist.json');

  beforeAll(async () => {
    await Bun.write(configPath, JSON.stringify({
      mode: 'whitelist',
      commands: { allow: ['bun'] },
      flags: { bun: { allow: ['version'] } },
    }));

    serverProcess = spawn(['bun', 'run', './bashful.ts', '--config', configPath, 'bun'], {
      env: { ...process.env, PORT: String(PORT) },
      stdout: 'ignore',
      stderr: 'ignore'
    });
    await new Promise(r => setTimeout(r, 600));
  });

  afterAll(() => {
    if (serverProcess) serverProcess.kill();
  });

  test('the whitelisted flag runs', async () => {
    const res = await fetch(`${baseUrl}/bun`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: true })
    });
    expect(res.status).toBe(200);
  });

  test('any other flag is rejected', async () => {
    const res = await fetch(`${baseUrl}/bun`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: true })
    });
    expect(res.status).toBe(403);
  });

  test('the schema only advertises whitelisted flags', async () => {
    const res = await fetch(`${baseUrl}/bun/schema`);
    const schema = await res.json() as Record<string, unknown>;
    expect(Object.keys(schema).every(k => k === 'version')).toBe(true);
  });
});
