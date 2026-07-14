import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  splitSegments,
  parseSchema,
  buildCLIArgs,
  tokenizeArgs,
  PayloadError,
  parseConfig,
  normalizeConfig,
  extractOptions,
  parseHostHeader,
  isLoopbackHost,
  isAllowedHost,
  buildCorsHeaders,
  isJsonContentType,
  wantsJson,
  parseNumberOption,
  extractFlagNames,
  effectiveFlagPolicy,
  authorizeCommand,
  authorizeFlags,
  authorizeValues,
  extractFlagValues,
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

// ── tokenizeArgs ──────────────────────────────────────────────────────────────

describe('tokenizeArgs', () => {
  test('splits on whitespace', () => {
    expect(tokenizeArgs('http://example.com --silent')).toEqual(['http://example.com', '--silent']);
  });

  test('collapses runs of whitespace', () => {
    expect(tokenizeArgs('  a   b \t c ')).toEqual(['a', 'b', 'c']);
  });

  test('keeps a double-quoted value with spaces together', () => {
    expect(tokenizeArgs('--data "hello world"')).toEqual(['--data', 'hello world']);
  });

  test('keeps a single-quoted value with spaces together', () => {
    expect(tokenizeArgs("--data 'hello world'")).toEqual(['--data', 'hello world']);
  });

  test('quotes can be embedded mid-token', () => {
    expect(tokenizeArgs('--header="A: 1"')).toEqual(['--header=A: 1']);
  });

  test('the other quote survives inside a quoted run', () => {
    expect(tokenizeArgs(`--msg "it's fine"`)).toEqual(['--msg', "it's fine"]);
  });

  test('an explicitly empty argument is preserved', () => {
    expect(tokenizeArgs('--value ""')).toEqual(['--value', '']);
  });

  test('empty input yields no args', () => {
    expect(tokenizeArgs('')).toEqual([]);
    expect(tokenizeArgs('   ')).toEqual([]);
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

  test('parses a short-only flag (no long form)', () => {
    const schema = parseSchema('  -v                     Be verbose');
    expect(schema['v']).toMatchObject({
      shortFlag: '-v',
      longFlag: '-v', // what actually gets emitted
      type: 'boolean',
      description: 'Be verbose',
    });
    expect(buildCLIArgs({ v: true }, schema)).toEqual(['-v']);
  });

  test('parses a short-only flag that takes a value', () => {
    const schema = parseSchema('  -X <method>            Request method');
    expect(schema['X']).toMatchObject({ longFlag: '-X', type: 'method' });
    expect(buildCLIArgs({ X: 'POST' }, schema)).toEqual(['-X', 'POST']);
  });

  test('parses the --flag=<value> form', () => {
    const schema = parseSchema('  --output=<file>        Write output here');
    expect(schema['output']).toMatchObject({
      longFlag: '--output',
      type: 'file',
      description: 'Write output here',
    });
    // The '=' is a help-text convention; we still emit the conventional form.
    expect(buildCLIArgs({ output: 'f.txt' }, schema)).toEqual(['--output', 'f.txt']);
  });

  test('parses a flag with no description', () => {
    const schema = parseSchema('  --silent');
    expect(schema['silent']).toMatchObject({ longFlag: '--silent', type: 'boolean', description: '' });
  });

  test('parses a valueless flag at end of line with a short partner', () => {
    const schema = parseSchema('  -s, --silent');
    expect(schema['silent']).toMatchObject({ shortFlag: '-s', longFlag: '--silent' });
  });

  test('an all-caps word in the description is not mistaken for a value type', () => {
    // Two+ spaces means the description started; a value is separated by one.
    const schema = parseSchema('  --quiet                URL fetching stays silent');
    expect(schema['quiet'].type).toBe('boolean');
    expect(schema['quiet'].description).toBe('URL fetching stays silent');
  });

  test('the first definition of a flag wins over later mentions', () => {
    const schema = parseSchema([
      '  -o, --output <file>    Write to file',
      'Examples:',
      '  --output',
    ].join('\n'));
    expect(schema['output']).toMatchObject({ type: 'file', description: 'Write to file' });
  });

  test('a short flag and a long flag on separate lines stay separate entries', () => {
    const schema = parseSchema([
      '  -v                     Be verbose',
      '  --version              Print version',
    ].join('\n'));
    expect(schema['v'].longFlag).toBe('-v');
    expect(schema['version'].longFlag).toBe('--version');
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

  // Repeatable flags — curl -H, docker -e, and friends.
  test('an array repeats the flag once per element', () => {
    const schema = { header: { longFlag: '--header', type: 'string' } };
    expect(buildCLIArgs({ header: ['A: 1', 'B: 2'] }, schema))
      .toEqual(['--header', 'A: 1', '--header', 'B: 2']);
  });

  test('an array on an unknown key repeats too', () => {
    expect(buildCLIArgs({ H: ['a', 'b'] }, {})).toEqual(['-H', 'a', '-H', 'b']);
  });

  test('a single-element array behaves like a bare value', () => {
    expect(buildCLIArgs({ output: ['f.txt'] }, curlSchema)).toEqual(['--output', 'f.txt']);
  });

  test('an empty array emits nothing', () => {
    expect(buildCLIArgs({ output: [] }, curlSchema)).toEqual([]);
  });

  test('numbers are rendered as values', () => {
    expect(buildCLIArgs({ retry: 3 }, {})).toEqual(['--retry', '3']);
  });

  test('null and undefined emit nothing', () => {
    expect(buildCLIArgs({ output: null, silent: undefined }, curlSchema)).toEqual([]);
  });

  test('an object value is rejected rather than passed as [object Object]', () => {
    expect(() => buildCLIArgs({ output: { a: 1 } }, curlSchema)).toThrow(PayloadError);
    expect(() => buildCLIArgs({ output: { a: 1 } }, curlSchema)).toThrow(/not a valid value/);
  });

  test('an object inside an array is rejected', () => {
    expect(() => buildCLIArgs({ header: [{ a: 1 }] }, {})).toThrow(PayloadError);
  });

  test('a nested array is rejected', () => {
    expect(() => buildCLIArgs({ header: [['a']] }, {})).toThrow(PayloadError);
  });

  test('a non-string _args is rejected', () => {
    expect(() => buildCLIArgs({ _args: { url: 'x' } }, curlSchema)).toThrow(PayloadError);
    expect(() => buildCLIArgs({ _args: [{ url: 'x' }] }, curlSchema)).toThrow(PayloadError);
  });

  test('numeric positional args are accepted', () => {
    expect(buildCLIArgs({ _args: [8080] }, {})).toEqual(['8080']);
  });

  test('_stdin is not emitted as a flag', () => {
    expect(buildCLIArgs({ _stdin: 'hello', silent: true }, curlSchema)).toEqual(['--silent']);
  });

  test('a non-string _stdin is rejected', () => {
    expect(() => buildCLIArgs({ _stdin: { a: 1 } }, {})).toThrow(PayloadError);
    expect(() => buildCLIArgs({ _stdin: 42 }, {})).toThrow(/must be a string/);
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

  test('--timeout is taken in seconds and stored as ms', () => {
    expect(extractOptions(['--timeout', '2.5', 'curl']).timeoutMs).toBe(2500);
    expect(extractOptions(['curl']).timeoutMs).toBe(0); // no limit by default
  });

  test('--max-concurrency overrides the default cap', () => {
    expect(extractOptions(['curl']).maxConcurrent).toBe(16);
    expect(extractOptions(['--max-concurrency=1', 'curl']).maxConcurrent).toBe(1);
    expect(extractOptions(['--max-concurrency', '0', 'curl']).maxConcurrent).toBe(0); // unlimited
  });

  test('a nonsense numeric option is rejected at startup', () => {
    expect(() => extractOptions(['--timeout', 'soon', 'curl'])).toThrow(/non-negative number/);
    expect(() => extractOptions(['--max-concurrency=-3', 'curl'])).toThrow(/non-negative number/);
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

describe('wantsJson', () => {
  test('detects an application/json Accept header', () => {
    expect(wantsJson('application/json')).toBe(true);
    expect(wantsJson('application/json, text/plain;q=0.9')).toBe(true);
    expect(wantsJson('text/html, application/json;q=0.8')).toBe(true);
  });

  test('anything else streams', () => {
    expect(wantsJson('text/plain')).toBe(false);
    expect(wantsJson('*/*')).toBe(false);
    expect(wantsJson(null)).toBe(false);
  });
});

describe('parseNumberOption', () => {
  test('accepts non-negative numbers', () => {
    expect(parseNumberOption('0', '--timeout')).toBe(0);
    expect(parseNumberOption('2.5', '--timeout')).toBe(2.5);
  });

  test('rejects negatives and non-numbers', () => {
    expect(() => parseNumberOption('-1', '--timeout')).toThrow(/non-negative/);
    expect(() => parseNumberOption('soon', '--timeout')).toThrow(/non-negative/);
    expect(() => parseNumberOption('', '--timeout')).toThrow(/non-negative/);
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

  // These must agree with buildCLIArgs — a value that emits nothing must not be
  // judged by the policy, or a rule could fire for a flag that never runs.
  test('omits values that build to nothing', () => {
    expect(extractFlagNames({ a: null, b: undefined, c: [], d: false, e: 'x' })).toEqual(['e']);
  });

  test('an array counts once', () => {
    expect(extractFlagNames({ header: ['A', 'B'] })).toEqual(['header']);
  });

  test('_stdin is governable — it is input to the command like any flag', () => {
    expect(extractFlagNames({ _stdin: 'data' })).toEqual(['_stdin']);
    expect(extractFlagNames({ _stdin: '' })).toEqual([]);
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

// ── authorizeValues ───────────────────────────────────────────────────────────

describe('extractFlagValues', () => {
  test('collects the values a payload would emit', () => {
    expect(extractFlagValues({ output: 'f.txt', retry: 3 })).toEqual({ output: ['f.txt'], retry: ['3'] });
  });

  test('an array yields every value', () => {
    expect(extractFlagValues({ header: ['A', 'B'] })).toEqual({ header: ['A', 'B'] });
  });

  test('bare booleans emit no value to check', () => {
    expect(extractFlagValues({ silent: true, verbose: 'true', quiet: false })).toEqual({});
  });
});

describe('authorizeValues', () => {
  test('allows anything when no patterns are configured', () => {
    expect(authorizeValues('curl', { output: '/etc/passwd' }, DEFAULT_CONFIG).allowed).toBe(true);
  });

  test('constrains a flag value to its pattern', () => {
    const config = normalizeConfig({ flags: { curl: { values: { output: '^/tmp/' } } } });
    expect(authorizeValues('curl', { output: '/tmp/out.html' }, config).allowed).toBe(true);

    const decision = authorizeValues('curl', { output: '/etc/passwd' }, config);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain('/etc/passwd');
  });

  test('constrains positional args — the URL curl is allowed to fetch', () => {
    const config = normalizeConfig({ flags: { curl: { values: { _args: '^https://api\\.example\\.com/' } } } });
    expect(authorizeValues('curl', { _args: ['https://api.example.com/v1/users'] }, config).allowed).toBe(true);
    expect(authorizeValues('curl', { _args: ['https://evil.example/'] }, config).allowed).toBe(false);
  });

  test('every element of an array must match', () => {
    const config = normalizeConfig({ flags: { curl: { values: { _args: '^https://' } } } });
    expect(authorizeValues('curl', { _args: ['https://a.test', 'http://b.test'] }, config).allowed).toBe(false);
  });

  test('a flag used as a bare boolean has no value to constrain', () => {
    const config = normalizeConfig({ flags: { curl: { values: { output: '^/tmp/' } } } });
    expect(authorizeValues('curl', { output: true }, config).allowed).toBe(true);
  });

  test('a pattern for an unused flag is inert', () => {
    const config = normalizeConfig({ flags: { curl: { values: { output: '^/tmp/' } } } });
    expect(authorizeValues('curl', { silent: true }, config).allowed).toBe(true);
  });

  test("a command's pattern overrides the wildcard's for the same flag", () => {
    const config = normalizeConfig({
      flags: { '*': { values: { output: '^/tmp/' } }, curl: { values: { output: '^/var/' } } },
    });
    expect(authorizeValues('curl', { output: '/var/x' }, config).allowed).toBe(true);
    expect(authorizeValues('curl', { output: '/tmp/x' }, config).allowed).toBe(false);
    // wget has no override, so it still inherits the wildcard.
    expect(authorizeValues('wget', { output: '/tmp/x' }, config).allowed).toBe(true);
  });

  test('a broken regex is rejected at config load, not at request time', () => {
    expect(() => normalizeConfig({ flags: { curl: { values: { output: '[unclosed' } } } }))
      .toThrow(/not a valid regex/);
  });

  test('a non-string pattern is rejected', () => {
    expect(() => normalizeConfig({ flags: { curl: { values: { output: 3 } } } }))
      .toThrow(/must be a regex string/);
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

  test('value patterns are enforced as part of the full request check', () => {
    const strict = normalizeConfig({
      mode: 'whitelist',
      commands: { allow: ['curl'] },
      flags: { curl: { allow: ['_args', 'output'], values: { _args: '^https://ok\\.test/' } } },
    });
    expect(authorizeRequest('curl', { _args: ['https://ok.test/a'] }, strict).allowed).toBe(true);
    expect(authorizeRequest('curl', { _args: ['https://evil.test/a'] }, strict).allowed).toBe(false);
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

  test('the UI ships the real tokenizer rather than a reimplementation', async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    expect(html).toContain('function tokenizeArgs');
    expect(html).toContain('payload._args = tokenizeArgs(argsVal)');
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

  test('an object-valued flag is rejected with 400, not run as [object Object]', async () => {
    const res = await fetch(`${baseUrl}/bun`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eval: { nested: true } })
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { reason: string }).reason).toMatch(/not a valid value/);
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
          values: { _args: '^--(print|version)$' },
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

  test('a positional arg matching its value pattern is allowed', async () => {
    const res = await post({ _args: ['--version'] });
    expect(res.status).toBe(200);
  });

  test('a positional arg violating its value pattern is rejected with 403', async () => {
    const res = await post({ _args: ['--eval', 'process.exit(1)'] });
    expect(res.status).toBe(403);
    expect((await res.json() as { reason: string }).reason).toMatch(/does not match the required pattern/);
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

  test('a repeated query param repeats the flag instead of keeping only the last', async () => {
    // `bun --eval a --eval b` — bun rejects the repeat, but its complaint proves
    // both values reached the command rather than being collapsed into one.
    const res = await fetch(`${baseUrl}/bun?_args=--print&_args=1%2B1`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('2');
  });
});

describe('Integration: process lifecycle', () => {
  let serverProcess: ReturnType<typeof spawn>;
  const PORT = 3011;
  const baseUrl = `http://localhost:${PORT}`;

  beforeAll(async () => {
    serverProcess = spawn(
      ['bun', 'run', './bashful.ts', '--allow-get', '--timeout', '1', '--max-concurrency', '2', 'bun'],
      { env: { ...process.env, PORT: String(PORT) }, stdout: 'ignore', stderr: 'ignore' }
    );
    await new Promise(r => setTimeout(r, 600));
  });

  afterAll(() => {
    if (serverProcess) serverProcess.kill();
  });

  const json = (body: unknown) => fetch(`${baseUrl}/bun`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  });

  test('an Accept: application/json request gets the exit code', async () => {
    const res = await json({ version: true });
    expect(res.status).toBe(200);
    const body = await res.json() as { exitCode: number; stdout: string; stderr: string };
    expect(body.exitCode).toBe(0);
    expect(body.stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  test('a failing command reports a non-zero exit code instead of a silent 200', async () => {
    // Previously a failing command returned 200 with its error text in the body,
    // so a programmatic client could not tell success from failure.
    const body = await (await json({ _args: ['--eval', 'process.exit(3)'] })).json() as {
      exitCode: number;
    };
    expect(body.exitCode).toBe(3);
  });

  test('_stdin is piped to the command', async () => {
    const body = await (await json({
      _args: ['--print', 'await Bun.stdin.text()'],
      _stdin: 'piped-in-payload',
    })).json() as { stdout: string };
    expect(body.stdout).toContain('piped-in-payload');
  });

  test('a command that reads stdin does not hang when none is given', async () => {
    // stdin is closed rather than inherited, so this returns immediately.
    const body = await (await json({ _args: ['--print', '(await Bun.stdin.text()).length'] })).json() as {
      exitCode: number; stdout: string;
    };
    expect(body.exitCode).toBe(0);
    expect(body.stdout).toContain('0');
  }, 10_000);

  test('stdout and stderr are separated in JSON mode', async () => {
    const body = await (await json({ _args: ['--print', 'console.error("to-stderr"); "to-stdout"'] })).json() as {
      stdout: string; stderr: string;
    };
    expect(body.stdout).toContain('to-stdout');
    expect(body.stderr).toContain('to-stderr');
  });

  test('a command exceeding --timeout is killed', async () => {
    const started = Date.now();
    const body = await (await json({ _args: ['--eval', 'await Bun.sleep(30000)'] })).json() as {
      timedOut: boolean; exitCode: number;
    };
    const elapsed = Date.now() - started;
    expect(body.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(10_000); // killed at ~1s, not after 30s
  }, 15_000);

  test('requests beyond --max-concurrency are rejected with 429', async () => {
    // Two slow commands saturate the cap of 2; the third must be turned away.
    const slow = () => json({ _args: ['--eval', 'await Bun.sleep(3000)'] });
    const a = slow(), b = slow();
    await new Promise(r => setTimeout(r, 300)); // let both start
    const third = await fetch(`${baseUrl}/bun?version=true`);
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBe('1');
    await Promise.all([a, b]);
  }, 15_000);

  test('capacity is released once commands finish', async () => {
    const res = await fetch(`${baseUrl}/bun?version=true`);
    expect(res.status).toBe(200);
  });
});

describe('Integration: client disconnect', () => {
  let serverProcess: ReturnType<typeof spawn>;
  const PORT = 3012;
  const baseUrl = `http://localhost:${PORT}`;

  beforeAll(async () => {
    // A cap of 1 makes the kill observable: the slot only frees up if the
    // process actually died. Otherwise the next request would get a 429.
    serverProcess = spawn(
      ['bun', 'run', './bashful.ts', '--allow-get', '--max-concurrency', '1', 'bun'],
      { env: { ...process.env, PORT: String(PORT) }, stdout: 'ignore', stderr: 'ignore' }
    );
    await new Promise(r => setTimeout(r, 600));
  });

  afterAll(() => {
    if (serverProcess) serverProcess.kill();
  });

  test('hanging up kills the command instead of orphaning it', async () => {
    const controller = new AbortController();
    const slow = fetch(`${baseUrl}/bun`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _args: ['--eval', 'await Bun.sleep(30000)'] }),
      signal: controller.signal,
    }).catch(() => { /* aborted, as intended */ });

    await new Promise(r => setTimeout(r, 400)); // let the command start
    controller.abort();
    await slow;
    await new Promise(r => setTimeout(r, 400)); // let the kill land

    // The 30s sleep is still notionally running. If it were orphaned, the single
    // slot would still be occupied and this would be a 429.
    const res = await fetch(`${baseUrl}/bun?version=true`);
    expect(res.status).toBe(200);
  }, 15_000);
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
