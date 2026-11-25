import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PERIOD,
  STATE,
  addWorkingDays,
  applyGrace,
  classifyWorklogs,
  defaultConfig,
  describeGrace,
  graceFromToken,
  graceToken,
  normaliseConfig,
  validateConfig,
  violationSince,
} from '../src/shared/rules.mjs';

const config = (overrides = {}) => ({ ...defaultConfig(), ...overrides });
const worklog = (id, started) => ({
  id,
  started: new Date(started).toISOString(),
  timeSpent: '1m',
  timeSpentSeconds: 60,
  authorAccountId: 'acct-1',
  authorDisplayName: 'Ravi Acharya',
});

const at = (iso) => new Date(iso);
const stamp = (date) => date.toISOString().slice(0, 16).replace('T', ' ');

/* -------------------------------------------------------- working-day maths -- */

describe('addWorkingDays', () => {
  it('counts the month-end day itself when the 1st is a weekday', () => {
    // 1 Sep 2026 is a Tuesday. Tue 1, Wed 2, Thu 3, Fri 4 -> deadline Sat 5th.
    assert.equal(stamp(addWorkingDays(at('2026-09-01T00:00:00Z'), 4)), '2026-09-05 00:00');
  });

  it('skips a weekend that falls inside the window', () => {
    // 1 Oct 2026 is a Thursday. Thu 1, Fri 2, weekend skipped, Mon 5, Tue 6.
    assert.equal(stamp(addWorkingDays(at('2026-10-01T00:00:00Z'), 4)), '2026-10-07 00:00');
  });

  it('starts on the Monday when the month ends on a Saturday', () => {
    // 1 Aug 2026 is a Saturday. Mon 3, Tue 4, Wed 5, Thu 6.
    assert.equal(stamp(addWorkingDays(at('2026-08-01T00:00:00Z'), 4)), '2026-08-07 00:00');
  });

  it('starts on the Monday when the month ends on a Sunday', () => {
    // 1 Nov 2026 is a Sunday. Mon 2, Tue 3, Wed 4, Thu 5.
    assert.equal(stamp(addWorkingDays(at('2026-11-01T00:00:00Z'), 4)), '2026-11-06 00:00');
  });

  it('does not count a partial first day', () => {
    // Mid-afternoon Tuesday. Wed 2, Thu 3, Fri 4, Mon 7 -> Tue 8th.
    assert.equal(stamp(addWorkingDays(at('2026-09-01T14:30:00Z'), 4)), '2026-09-08 00:00');
  });

  it('crosses a month boundary', () => {
    // Thu 24 Sep: Thu 24, Fri 25, Mon 28, Tue 29, Wed 30.
    assert.equal(stamp(addWorkingDays(at('2026-09-24T00:00:00Z'), 5)), '2026-10-01 00:00');
  });

  it('handles a ten-day window spanning two weekends', () => {
    // Tue 1 Sep + 10 working days lands on Tue 15 Sep.
    assert.equal(stamp(addWorkingDays(at('2026-09-01T00:00:00Z'), 10)), '2026-09-15 00:00');
  });

  it('returns the input unchanged for a zero-day window', () => {
    assert.equal(stamp(addWorkingDays(at('2026-09-01T09:15:00Z'), 0)), '2026-09-01 09:15');
  });

  it('survives an unparseable date rather than looping', () => {
    assert.ok(Number.isNaN(addWorkingDays(new Date('nonsense'), 4).getTime()));
  });
});

/* --------------------------------------------------------- the rule in full -- */

describe('working-day grace end to end', () => {
  // The policy as stated: once the month completes, four working days to fix it.
  const cfg = config({
    period: PERIOD.LAST_MONTH,
    enforcementGraceHours: 0,
    enforcementGraceWorkingDays: 4,
  });

  const august = worklog('a', '2026-08-15T09:00:00Z');

  it('holds August work in grace through the fourth working day', () => {
    const { results } = classifyWorklogs({
      worklogs: [august],
      config: cfg,
      now: at('2026-09-04T23:00:00Z'),
    });
    assert.equal(results[0].state, STATE.GRACE);
    assert.equal(results[0].enforceAt, '2026-09-05T00:00:00.000Z');
  });

  it('enforces from the start of the fifth day', () => {
    const { results } = classifyWorklogs({
      worklogs: [august],
      config: cfg,
      now: at('2026-09-05T00:00:00Z'),
    });
    assert.equal(results[0].state, STATE.ENFORCE);
  });

  it('gives a longer real window than 48 hours would over a weekend', () => {
    // July closes on Sat 1 Aug. 48 hours expires Mon 3 Aug 00:00, before anyone
    // is back at a desk; four working days runs to Fri 7 Aug.
    const july = worklog('b', '2026-07-15T09:00:00Z');
    const now = at('2026-08-01T00:00:00Z');

    const byHours = classifyWorklogs({
      worklogs: [july],
      config: config({ period: PERIOD.LAST_MONTH, enforcementGraceHours: 48 }),
      now,
    }).results[0];

    const byDays = classifyWorklogs({ worklogs: [july], config: cfg, now }).results[0];

    assert.equal(byHours.enforceAt, '2026-08-03T00:00:00.000Z');
    assert.equal(byDays.enforceAt, '2026-08-07T00:00:00.000Z');
  });

  it('still refuses a fresh window to an already-stale violation', () => {
    const { results } = classifyWorklogs({
      worklogs: [worklog('c', '2025-03-02T09:00:00Z')],
      config: cfg,
      now: at('2026-09-16T12:00:00Z'),
    });
    assert.equal(results[0].state, STATE.ENFORCE);
  });

  it('is still a pure function of the worklog — same answer whenever evaluated', () => {
    const deadlines = ['2026-09-02T08:00:00Z', '2026-09-03T20:00:00Z', '2027-01-09T00:00:00Z'].map(
      (now) => classifyWorklogs({ worklogs: [august], config: cfg, now: at(now) }).results[0].enforceAt,
    );
    assert.deepEqual(new Set(deadlines).size, 1);
  });

  it('applies to every period type, not just the calendar month', () => {
    const weekly = config({
      period: PERIOD.LAST_WEEK,
      enforcementGraceHours: 0,
      enforcementGraceWorkingDays: 4,
    });
    // Breach Tue 1 Sep 09:00. Partial day ignored: Wed 2, Thu 3, Fri 4, Mon 7.
    const since = violationSince({ worklog: worklog('d', '2026-08-25T09:00:00Z'), config: weekly });
    assert.equal(applyGrace(since, weekly).toISOString(), '2026-09-08T00:00:00.000Z');
  });
});

/* -------------------------------------------------------------- config shape -- */

describe('grace configuration', () => {
  it('defaults to hours, so existing installs are untouched', () => {
    assert.equal(defaultConfig().enforcementGraceWorkingDays, null);
    assert.equal(graceToken(defaultConfig()), 'h:48');
  });

  it('normalises a config saved before working days existed', () => {
    const stored = { period: PERIOD.LAST_MONTH, enforcementGraceHours: 48 };
    assert.equal(normaliseConfig(stored).enforcementGraceWorkingDays, null);
  });

  it('treats zero, negative and junk as "use hours"', () => {
    for (const value of [0, -3, 'abc', null, undefined, {}]) {
      assert.equal(
        normaliseConfig({ enforcementGraceWorkingDays: value }).enforcementGraceWorkingDays,
        null,
      );
    }
  });

  it('round-trips a token through the config and back', () => {
    assert.deepEqual(graceFromToken('wd:4'), {
      enforcementGraceHours: 0,
      enforcementGraceWorkingDays: 4,
    });
    assert.equal(graceToken(config(graceFromToken('wd:4'))), 'wd:4');
    assert.equal(graceToken(config(graceFromToken('h:24'))), 'h:24');
  });

  it('clears the abandoned family when switching, so neither lingers', () => {
    const backToHours = config(graceFromToken('h:24'));
    assert.equal(backToHours.enforcementGraceWorkingDays, null);
    assert.equal(graceToken(backToHours), 'h:24');
  });

  it('accepts a working-day grace as a valid configuration', () => {
    assert.equal(validateConfig(config(graceFromToken('wd:4'))).ok, true);
  });

  it('rejects a working-day count that is not on the list', () => {
    const result = validateConfig(config({ enforcementGraceWorkingDays: 3.5 }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.enforcementGraceWorkingDays);
  });
});

/* ------------------------------------------------------------- the explainer -- */

describe('describeGrace', () => {
  const sept16 = at('2026-09-16T12:00:00Z');

  it('names the concrete deadline for last month under a 4-working-day grace', () => {
    const { window, deadline } = describeGrace(
      config({ period: PERIOD.LAST_MONTH, enforcementGraceWorkingDays: 4 }),
      sept16,
    );
    assert.match(window, /4 working days/);
    assert.match(window, /Weekends are skipped/);
    assert.match(deadline, /Work dated in August 2026/);
    assert.match(deadline, /Tue, Sep 1, 2026/);
    assert.match(deadline, /Sat, Sep 5, 2026/);
  });

  it('is explicit that public holidays are not excluded', () => {
    const { window } = describeGrace(config({ enforcementGraceWorkingDays: 4 }), sept16);
    assert.match(window, /Public holidays are not excluded/);
  });

  it('describes an hours grace as elapsed time including weekends', () => {
    const { window } = describeGrace(config({ enforcementGraceHours: 48 }), sept16);
    assert.match(window, /48 hours of elapsed time, weekends included/);
  });

  it('says so plainly when there is no grace at all', () => {
    const { window, deadline } = describeGrace(
      config({ period: PERIOD.LAST_MONTH, enforcementGraceHours: 0 }),
      sept16,
    );
    assert.match(window, /enforced the moment it breaches/);
    assert.match(deadline, /enforceable immediately/);
  });

  it('agrees with what classifyWorklogs computes', () => {
    // Guards the explainer against drifting from the rule it describes.
    const cfg = config({ period: PERIOD.LAST_MONTH, enforcementGraceWorkingDays: 4 });
    const { results } = classifyWorklogs({
      worklogs: [worklog('a', '2026-08-15T09:00:00Z')],
      config: cfg,
      now: sept16,
    });
    assert.equal(results[0].enforceAt, '2026-09-05T00:00:00.000Z');
    assert.match(describeGrace(cfg, sept16).deadline, /Sat, Sep 5, 2026/);
  });
});
