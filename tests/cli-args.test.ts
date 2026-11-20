import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseCliArgs,
  parseFilterArgs,
  parsePositiveIntArg,
} from '../src/cli/args.js';
import { formatSalary } from '../src/cli/commands.js';

describe('CLI argument parsers and formatters', () => {
  it('validates status and resolves source aliases in parseFilterArgs', () => {
    assert.deepEqual(parseFilterArgs(undefined, undefined), {
      ok: true,
      status: undefined,
      source: undefined,
    });
    assert.deepEqual(parseFilterArgs('saved', 'mcf'), {
      ok: true,
      status: 'saved',
      source: 'mycareersfuture',
    });

    const badStatus = parseFilterArgs('bogus', undefined);
    assert.equal(badStatus.ok, false);

    const badSource = parseFilterArgs('new', 'nonexistent');
    assert.equal(badSource.ok, false);
  });

  it('validates and clamps positive integers in parsePositiveIntArg', () => {
    assert.deepEqual(parsePositiveIntArg('days', undefined), {
      ok: true,
      value: undefined,
    });
    assert.deepEqual(parsePositiveIntArg('days', '7'), {
      ok: true,
      value: 7,
    });
    assert.deepEqual(parsePositiveIntArg('limit', '250', 100), {
      ok: true,
      value: 100,
    });

    for (const bad of ['0', '-5', 'abc', '3.5', '']) {
      const res = parsePositiveIntArg('limit', bad);
      assert.equal(res.ok, false, `expected "${bad}" to fail validation`);
    }
  });

  it('parses CLI commands and short/long flags', () => {
    const parsed = parseCliArgs(['full', '-q', 'TypeScript', '-l', '30', '--days', '14']);
    assert.equal(parsed.command, 'full');
    assert.equal(parsed.values.query, 'TypeScript');
    assert.equal(parsed.values.limit, '30');
    assert.equal(parsed.values.days, '14');
  });

  it('formats salary ranges and missing salaries cleanly', () => {
    assert.equal(formatSalary(null, null, 'SGD', 'monthly'), 'N/A');
    assert.equal(formatSalary(8000, 12000, 'SGD', 'monthly'), 'SGD 8000-12000/monthly');
    assert.equal(formatSalary(9000, 9000, 'SGD', 'monthly'), 'SGD 9000/monthly');
    assert.equal(formatSalary(10000, null, 'SGD', null), 'SGD 10000');
  });
});
