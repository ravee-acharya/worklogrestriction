import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyFilters,
  authorKey,
  authorOptions,
  describeFilters,
  filterFileSuffix,
  hasActiveFilters,
  monthKey,
  monthLabel,
  monthOptions,
} from '../src/shared/filters.mjs';
import { exportFileName } from '../src/shared/exports.mjs';

const entry = (overrides = {}) => ({
  id: 'ABC-1:1',
  issueKey: 'ABC-1',
  authorAccountId: 'acct-1',
  authorDisplayName: 'Ada Lovelace',
  worklogStarted: '2026-08-15T09:00:00.000Z',
  removedAt: '2026-09-02T10:00:00.000Z',
  ...overrides,
});

const DATA = [
  entry({ id: 'a', worklogStarted: '2026-08-15T09:00:00.000Z', authorAccountId: 'acct-1', authorDisplayName: 'Ada Lovelace' }),
  entry({ id: 'b', worklogStarted: '2026-08-02T09:00:00.000Z', authorAccountId: 'acct-2', authorDisplayName: 'Grace Hopper' }),
  entry({ id: 'c', worklogStarted: '2026-07-20T09:00:00.000Z', authorAccountId: 'acct-1', authorDisplayName: 'Ada Lovelace' }),
  entry({ id: 'd', worklogStarted: '2026-06-01T09:00:00.000Z', authorAccountId: 'acct-3', authorDisplayName: 'Alan Turing' }),
];

const ids = (rows) => rows.map((row) => row.id);

/* ------------------------------------------------------------------ months -- */

describe('month keys and labels', () => {
  it('derives a sortable UTC month key', () => {
    assert.equal(monthKey('2026-08-15T09:00:00.000Z'), '2026-08');
    assert.equal(monthKey(new Date('2026-01-01T00:00:00.000Z')), '2026-01');
  });

  it('returns empty rather than a bogus key for unusable input', () => {
    for (const value of [null, undefined, '', 'nonsense']) {
      assert.equal(monthKey(value), '');
    }
  });

  it('renders a readable label', () => {
    assert.equal(monthLabel('2026-08'), 'August 2026');
    assert.equal(monthLabel('bad'), '');
  });

  it('lists only months present in the data, newest first', () => {
    assert.deepEqual(
      monthOptions(DATA, 'worklogStarted').map((o) => o.value),
      ['2026-08', '2026-07', '2026-06'],
    );
  });

  it('skips entries whose date cannot be read', () => {
    const options = monthOptions([...DATA, entry({ id: 'x', worklogStarted: null })], 'worklogStarted');
    assert.equal(options.length, 3);
  });

  it('can group by a different date field', () => {
    // Removal date rather than worklog date — everything was removed in September.
    assert.deepEqual(monthOptions(DATA, 'removedAt').map((o) => o.value), ['2026-09']);
  });
});

/* ----------------------------------------------------------------- authors -- */

describe('author identity', () => {
  it('prefers the account id, which is stable across renames', () => {
    assert.equal(authorKey({ authorAccountId: 'acct-1', authorDisplayName: 'Ada Lovelace' }), 'id:acct-1');
  });

  it('falls back to the display name for older entries with no account id', () => {
    assert.equal(authorKey({ authorDisplayName: 'Ada Lovelace' }), 'name:Ada Lovelace');
  });

  it('returns empty when there is nothing to identify', () => {
    assert.equal(authorKey({}), '');
  });

  it('does not merge two people who share a display name', () => {
    const options = authorOptions([
      entry({ authorAccountId: 'acct-1', authorDisplayName: 'Ada Lovelace' }),
      entry({ authorAccountId: 'acct-9', authorDisplayName: 'Ada Lovelace' }),
    ]);
    assert.equal(options.length, 2);
  });

  it('disambiguates colliding names so the dropdown is not a coin toss', () => {
    const options = authorOptions([
      entry({ authorAccountId: 'acct-1', authorDisplayName: 'Ada Lovelace' }),
      entry({ authorAccountId: 'acct-9', authorDisplayName: 'Ada Lovelace' }),
    ]);
    assert.notEqual(options[0].label, options[1].label);
    for (const option of options) assert.ok(option.label.startsWith('Ada Lovelace (…'));
  });

  it('leaves a unique name untouched', () => {
    assert.equal(authorOptions(DATA).find((o) => o.label.startsWith('Ada Lovelace')).label, 'Ada Lovelace');
  });

  it('lists each person once, alphabetically', () => {
    assert.deepEqual(
      authorOptions(DATA).map((o) => o.label),
      ['Ada Lovelace', 'Alan Turing', 'Grace Hopper'],
    );
  });
});

/* --------------------------------------------------------------- filtering -- */

describe('applyFilters', () => {
  const opts = { dateField: 'worklogStarted' };

  it('returns everything when nothing is selected', () => {
    assert.deepEqual(ids(applyFilters(DATA, {}, opts)), ['a', 'b', 'c', 'd']);
  });

  it('filters by month', () => {
    assert.deepEqual(ids(applyFilters(DATA, { month: '2026-08' }, opts)), ['a', 'b']);
  });

  it('filters by user', () => {
    assert.deepEqual(ids(applyFilters(DATA, { author: 'id:acct-1' }, opts)), ['a', 'c']);
  });

  it('combines month and user as AND, not OR', () => {
    assert.deepEqual(ids(applyFilters(DATA, { month: '2026-08', author: 'id:acct-1' }, opts)), ['a']);
  });

  it('yields nothing for a combination with no matches', () => {
    assert.deepEqual(applyFilters(DATA, { month: '2026-06', author: 'id:acct-1' }, opts), []);
  });

  it('does not mutate the input', () => {
    const before = [...DATA];
    applyFilters(DATA, { month: '2026-08' }, opts);
    assert.deepEqual(DATA, before);
  });

  it('can filter on the removal date instead', () => {
    const byRemoval = applyFilters(DATA, { month: '2026-09' }, { dateField: 'removedAt' });
    assert.equal(byRemoval.length, 4);
  });

  it('excludes an entry whose date is unreadable when a month is selected', () => {
    const data = [...DATA, entry({ id: 'x', worklogStarted: 'nonsense' })];
    assert.ok(!ids(applyFilters(data, { month: '2026-08' }, opts)).includes('x'));
  });
});

describe('hasActiveFilters', () => {
  it('is false for the empty default', () => {
    assert.equal(hasActiveFilters({}), false);
    assert.equal(hasActiveFilters({ month: '', author: '' }), false);
  });

  it('is true when either filter is set', () => {
    assert.equal(hasActiveFilters({ month: '2026-08' }), true);
    assert.equal(hasActiveFilters({ author: 'id:acct-1' }), true);
  });
});

/* -------------------------------------------------------------- describing -- */

describe('describeFilters', () => {
  it('says "all entries" when nothing is filtered', () => {
    assert.equal(describeFilters({}, DATA), 'all entries');
  });

  it('names the month', () => {
    assert.equal(describeFilters({ month: '2026-08' }, DATA), 'August 2026');
  });

  it('names the person by display name, not account id', () => {
    assert.equal(describeFilters({ author: 'id:acct-1' }, DATA), 'Ada Lovelace');
  });

  it('names both when both are set', () => {
    assert.equal(describeFilters({ month: '2026-08', author: 'id:acct-2' }, DATA), 'August 2026, Grace Hopper');
  });

  it('degrades gracefully when the person is not in the data', () => {
    assert.equal(describeFilters({ author: 'id:gone' }, DATA), 'the selected user');
  });
});

/* ---------------------------------------------------------------- filename -- */

describe('filtered export filenames', () => {
  it('is empty when nothing is filtered, leaving the plain name', () => {
    assert.equal(filterFileSuffix({}, DATA), '');
    assert.equal(
      exportFileName('worklog-removal-log', new Date('2026-09-16T00:00:00Z'), ''),
      'worklog-removal-log-2026-09-16.xlsx',
    );
  });

  it('records the filter in the name so a partial export cannot pass as a full one', () => {
    const suffix = filterFileSuffix({ month: '2026-08', author: 'id:acct-1' }, DATA);
    assert.equal(suffix, '-2026-08-ada-lovelace');
    assert.equal(
      exportFileName('worklog-removal-log', new Date('2026-09-16T00:00:00Z'), suffix),
      'worklog-removal-log-2026-08-ada-lovelace-2026-09-16.xlsx',
    );
  });

  it('makes an awkward display name filename-safe', () => {
    const data = [entry({ authorAccountId: 'acct-7', authorDisplayName: "D'Souza, Maria (Ops)" })];
    const suffix = filterFileSuffix({ author: 'id:acct-7' }, data);
    assert.match(suffix, /^-[a-z0-9-]+$/);
    assert.ok(!suffix.includes(' '));
  });

  it('truncates a very long name rather than producing an unusable filename', () => {
    const data = [entry({ authorAccountId: 'acct-8', authorDisplayName: 'x'.repeat(80) })];
    assert.ok(filterFileSuffix({ author: 'id:acct-8' }, data).length <= 26);
  });
});
