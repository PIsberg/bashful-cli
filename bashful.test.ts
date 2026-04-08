import { describe, test, expect } from 'bun:test';
import { splitSegments, parseSchema, buildCLIArgs } from './bashful';

// ── splitSegments ─────────────────────────────────────────────────────────────

describe('splitSegments', () => {
  test('single command', () => {
    expect(splitSegments(['curl'])).toEqual([['curl']]);
  });

  test('single command with extra args (pipe mode)', () => {
    expect(splitSegments(['curl', '--help'])).toEqual([['curl', '--help']]);
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
