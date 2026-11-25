import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ACTION,
  DEFAULT_COMMENT_TEMPLATE,
  PERIOD,
  STATE,
  buildCommentDocument,
  PERIOD_LABELS,
  classifyWorklogs,
  dedupeStatuses,
  describePeriod,
  defaultConfig,
  evaluateWorklog,
  humaniseCountdown,
  isGrandfathered,
  normaliseConfig,
  renderCommentTemplate,
  resolveTransitionLock,
  summariseRemovals,
  toJiraDateTime,
  validateConfig,
  violationSince,
} from '../src/shared/rules.mjs';

const iso = (value) => new Date(value).toISOString();
const config = (overrides = {}) => ({ ...defaultConfig(), ...overrides });
const worklog = (id, started, extra = {}) => ({
  id,
  started: iso(started),
  timeSpent: '1m',
  timeSpentSeconds: 60,
  authorAccountId: 'acct-1',
  authorDisplayName: 'Ravi Acharya',
  ...extra,
});

/* -------------------------------------------------------------- period rules -- */

describe('period evaluation', () => {
  const now = new Date('2026-08-19T12:00:00Z');

  it('flags a worklog older than 7 days under Last 1 Week', () => {
    const rule = config({ period: PERIOD.LAST_WEEK });
    assert.equal(
      evaluateWorklog({ worklog: worklog('1', '2026-08-01T00:00:00Z'), config: rule, now }).violation,
      true,
    );
    assert.equal(
      evaluateWorklog({ worklog: worklog('2', '2026-08-18T00:00:00Z'), config: rule, now }).violation,
      false,
    );
  });

  it('treats Last Month as a calendar-month comparison, not 30 days', () => {
    const rule = config({ period: PERIOD.LAST_MONTH });
    // 20 days earlier, but still the same calendar month -> compliant.
    assert.equal(
      evaluateWorklog({ worklog: worklog('1', '2026-08-01T00:00:00Z'), config: rule, now }).violation,
      false,
    );
    // Only 1 day earlier, but the previous calendar month -> violation.
    assert.equal(
      evaluateWorklog({ worklog: worklog('2', '2026-07-31T23:00:00Z'), config: rule, now }).violation,
      true,
    );
  });

  it('treats Last Year as a calendar-year comparison', () => {
    const rule = config({ period: PERIOD.LAST_YEAR });
    assert.equal(
      evaluateWorklog({ worklog: worklog('1', '2026-01-01T00:00:00Z'), config: rule, now }).violation,
      false,
    );
    assert.equal(
      evaluateWorklog({ worklog: worklog('2', '2025-12-31T00:00:00Z'), config: rule, now }).violation,
      true,
    );
  });

  it('never flags anything when the transition rule has no target status', () => {
    const rule = config({ period: PERIOD.AFTER_TRANSITION, targetStatusName: null });
    const result = evaluateWorklog({
      worklog: worklog('1', '2020-01-01T00:00:00Z'),
      config: rule,
      changelog: [],
      now,
    });
    assert.equal(result.violation, false);
  });
});

/* ------------------------------------------------------------ transition lock -- */

describe('resolveTransitionLock', () => {
  const rule = config({
    period: PERIOD.AFTER_TRANSITION,
    targetStatusName: 'Done',
    transitionGraceHours: 24,
  });

  const changelog = [
    { created: iso('2026-08-01T10:00:00Z'), items: [{ field: 'status', fromString: 'To Do', toString: 'In progress' }] },
    { created: iso('2026-08-05T10:00:00Z'), items: [{ field: 'status', fromString: 'In progress', toString: 'Done' }] },
  ];

  it('locks from the inward transition plus the grace period', () => {
    const lock = resolveTransitionLock(changelog, rule);
    assert.equal(lock.lockedAt.toISOString(), iso('2026-08-05T10:00:00Z'));
    assert.equal(lock.lockTime.toISOString(), iso('2026-08-06T10:00:00Z'));
  });

  it('matches status names case-insensitively', () => {
    const lock = resolveTransitionLock(changelog, config({ ...rule, targetStatusName: 'done' }));
    assert.ok(lock, 'expected "done" to match "Done"');
  });

  it('clears the lock when the issue is reopened and reset-on-reopen is on', () => {
    const reopened = [
      ...changelog,
      { created: iso('2026-08-10T10:00:00Z'), items: [{ field: 'status', fromString: 'Done', toString: 'Reopened' }] },
    ];
    assert.equal(resolveTransitionLock(reopened, config({ ...rule, resetOnReopen: true })), null);
  });

  it('keeps the lock across a reopen when reset-on-reopen is off', () => {
    const reopened = [
      ...changelog,
      { created: iso('2026-08-10T10:00:00Z'), items: [{ field: 'status', fromString: 'Done', toString: 'Reopened' }] },
    ];
    const lock = resolveTransitionLock(reopened, config({ ...rule, resetOnReopen: false }));
    assert.equal(lock.lockedAt.toISOString(), iso('2026-08-05T10:00:00Z'));
  });

  it('re-locks after the issue re-enters the target status', () => {
    const cycled = [
      ...changelog,
      { created: iso('2026-08-10T10:00:00Z'), items: [{ field: 'status', fromString: 'Done', toString: 'Reopened' }] },
      { created: iso('2026-08-14T10:00:00Z'), items: [{ field: 'status', fromString: 'Reopened', toString: 'Done' }] },
    ];
    const lock = resolveTransitionLock(cycled, config({ ...rule, resetOnReopen: true }));
    assert.equal(lock.lockedAt.toISOString(), iso('2026-08-14T10:00:00Z'));
  });
});

/* ------------------------------------------------- the grace-period regression -- */

describe('enforcement grace period', () => {
  const rule = config({ period: PERIOD.LAST_WEEK, enforcementGraceHours: 48 });

  it('dates the breach 7 days after the worklog, then adds the grace', () => {
    // The reported case: logged Aug 1, so it breaches "Last 1 Week" on Aug 8 and
    // the 48h grace expires Aug 10 — both long past by Aug 19.
    const aug1 = worklog('w1', '2026-08-01T00:00:00Z');

    assert.equal(
      violationSince({ worklog: aug1, config: rule }).toISOString(),
      iso('2026-08-08T00:00:00Z'),
    );

    const { results } = classifyWorklogs({
      worklogs: [aug1],
      config: rule,
      now: new Date('2026-08-19T12:00:00Z'),
    });

    assert.equal(results[0].enforceAt, iso('2026-08-10T00:00:00Z'));
    assert.equal(results[0].state, STATE.ENFORCE, 'grace expired Aug 10, must enforce now');
  });

  it('holds a fresh violation in grace, then enforces once the window closes', () => {
    const aug1 = worklog('w1', '2026-08-01T00:00:00Z');

    // Aug 9: past the breach (Aug 8) but inside the 48h grace.
    const during = classifyWorklogs({
      worklogs: [aug1],
      config: rule,
      now: new Date('2026-08-09T00:00:00Z'),
    });
    assert.equal(during.results[0].state, STATE.GRACE);

    // One second past the deadline.
    const after = classifyWorklogs({
      worklogs: [aug1],
      config: rule,
      now: new Date('2026-08-10T00:00:01Z'),
    });
    assert.equal(after.results[0].state, STATE.ENFORCE);
  });

  it('gives the same deadline no matter when it is evaluated — the original bug', () => {
    const old = worklog('w1', '2026-06-29T00:00:00Z');
    const at = (when) =>
      classifyWorklogs({ worklogs: [old], config: rule, now: new Date(when) }).results[0].enforceAt;

    // The old build recomputed `now + 48h` every call, so this deadline walked
    // forward forever and enforcement never arrived.
    // Breach at Jun 29 + 7d = Jul 6; plus the 48h grace = Jul 8.
    assert.equal(at('2026-08-19T12:00:00Z'), iso('2026-07-08T00:00:00Z'));
    assert.equal(at('2026-09-30T12:00:00Z'), iso('2026-07-08T00:00:00Z'));
    assert.equal(at('2027-01-01T12:00:00Z'), iso('2026-07-08T00:00:00Z'));
  });

  it('does not grant a stale violation a fresh window when a project is enabled late', () => {
    // Enabling a project today must not reprieve a six-month-old violation.
    const ancient = worklog('w1', '2026-02-01T00:00:00Z');
    const { results } = classifyWorklogs({
      worklogs: [ancient],
      config: rule,
      now: new Date('2026-08-19T12:00:00Z'),
    });
    assert.equal(results[0].state, STATE.ENFORCE);
  });

  it('enforces immediately when no grace period is configured', () => {
    const { results } = classifyWorklogs({
      worklogs: [worklog('w1', '2026-06-29T00:00:00Z')],
      config: config({ period: PERIOD.LAST_WEEK, enforcementGraceHours: 0 }),
      now: new Date('2026-08-19T12:00:00Z'),
    });
    assert.equal(results[0].state, STATE.ENFORCE);
  });

  it('leaves compliant worklogs with no deadline at all', () => {
    const { results } = classifyWorklogs({
      worklogs: [worklog('fresh', '2026-08-18T00:00:00Z')],
      config: rule,
      now: new Date('2026-08-19T12:00:00Z'),
    });
    assert.equal(results[0].state, STATE.COMPLIANT);
    assert.equal(results[0].enforceAt, null);
    assert.equal(results[0].violationSince, null);
  });
});

/* -------------------------------------------------------------- comment ADF -- */

describe('buildCommentDocument', () => {
  const values = {
    authorName: 'Ravi Acharya',
    worklogDate: 'August 1, 2026',
    issueKey: 'POC-369',
    issueSummary: 'Probe subtask',
    restrictionRule: 'Last 1 Week',
    projectName: 'POC_SCRUM',
  };
  const mention = { accountId: 'acc-123', displayName: 'Ravi Acharya' };

  const flatten = (doc) => doc.content[0].content;

  it('emits a real mention node so Jira emails the author', () => {
    const doc = buildCommentDocument('Hi {{authorName}} — your worklog on {{worklogDate}}.', values, mention);
    const nodes = flatten(doc);

    const mentions = nodes.filter((n) => n.type === 'mention');
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0].attrs.id, 'acc-123');
    assert.equal(mentions[0].attrs.text, '@Ravi Acharya');
  });

  it('does not emit a stray @ beside the mention — the original defect', () => {
    const doc = buildCommentDocument('[System Notification] {{authorName}} Your worklog…', values, mention);
    const text = flatten(doc)
      .map((n) => (n.type === 'mention' ? n.attrs.text : n.text))
      .join('');

    assert.ok(!text.includes('@ @'), `double sigil in: ${text}`);
    assert.equal(text.match(/@/g).length, 1, 'exactly one @ in the rendered comment');
  });

  it('substitutes the other tokens as plain text around the mention', () => {
    const doc = buildCommentDocument('{{authorName}} logged on {{issueKey}} ({{restrictionRule}})', values, mention);
    const nodes = flatten(doc);
    assert.equal(nodes[0].type, 'mention');
    assert.equal(nodes[1].text, ' logged on POC-369 (Last 1 Week)');
  });

  it('falls back to plain text when there is no account id to mention', () => {
    const doc = buildCommentDocument('Hi {{authorName}}.', values, {});
    const nodes = flatten(doc);
    assert.ok(!nodes.some((n) => n.type === 'mention'));
    assert.equal(nodes[0].text, 'Hi Ravi Acharya.');
  });

  it('produces a valid ADF envelope', () => {
    const doc = buildCommentDocument(DEFAULT_COMMENT_TEMPLATE, values, mention);
    assert.equal(doc.type, 'doc');
    assert.equal(doc.version, 1);
    assert.equal(doc.content[0].type, 'paragraph');
    assert.ok(doc.content[0].content.length > 0);
  });

  it('never yields an empty paragraph, even for a token-only template', () => {
    const doc = buildCommentDocument('{{unknownToken}}', {}, {});
    assert.ok(doc.content[0].content.length > 0);
  });
});

/* --------------------------------------------------------- breach timestamps -- */

describe('violationSince', () => {
  it('dates a Last Month breach to the first of the following month', () => {
    const since = violationSince({
      worklog: worklog('w1', '2026-06-19T09:30:00Z'),
      config: config({ period: PERIOD.LAST_MONTH }),
    });
    assert.equal(since.toISOString(), iso('2026-07-01T00:00:00Z'));
  });

  it('dates a Last Year breach to Jan 1 of the following year', () => {
    const since = violationSince({
      worklog: worklog('w1', '2025-06-19T09:30:00Z'),
      config: config({ period: PERIOD.LAST_YEAR }),
    });
    assert.equal(since.toISOString(), iso('2026-01-01T00:00:00Z'));
  });

  it('dates a transition breach to whichever came later: the lock or the worklog', () => {
    const rule = {
      period: PERIOD.AFTER_TRANSITION,
      targetStatusName: 'Done',
      transitionGraceHours: 24,
    };
    const changelog = [
      { created: iso('2026-08-01T10:00:00Z'), items: [{ field: 'status', toString: 'Done' }] },
    ];
    // Lock time is Aug 1 10:00 + 24h = Aug 2 10:00.

    // Logged before the lock closed -> the lock is what starts the breach.
    const loggedEarly = violationSince({
      worklog: { id: 'a', started: iso('2026-08-05T00:00:00Z'), created: iso('2026-08-01T12:00:00Z') },
      config: config(rule),
      changelog,
    });
    assert.equal(loggedEarly.toISOString(), iso('2026-08-02T10:00:00Z'));

    // Logged well after the lock -> the worklog's own creation starts it.
    const loggedLate = violationSince({
      worklog: { id: 'b', started: iso('2026-08-05T00:00:00Z'), created: iso('2026-08-09T12:00:00Z') },
      config: config(rule),
      changelog,
    });
    assert.equal(loggedLate.toISOString(), iso('2026-08-09T12:00:00Z'));
  });
});

/* ------------------------------------------------------------------ validation -- */

describe('validateConfig', () => {
  it('rejects the transition rule when no target status is chosen', () => {
    const result = validateConfig(config({ period: PERIOD.AFTER_TRANSITION }));
    assert.equal(result.ok, false);
    assert.match(result.errors.targetStatusName, /status/i);
  });

  it('accepts the transition rule once a status is chosen', () => {
    const result = validateConfig(
      config({ period: PERIOD.AFTER_TRANSITION, targetStatusId: '3', targetStatusName: 'Done' }),
    );
    assert.equal(result.ok, true);
  });

  it('rejects an empty comment template in delete mode but allows it when flagging', () => {
    assert.equal(validateConfig(config({ commentTemplate: '   ' })).ok, false);
    assert.equal(
      validateConfig(config({ commentTemplate: '   ', action: ACTION.FLAG })).ok,
      true,
    );
  });

  it('accepts the shipped defaults', () => {
    assert.equal(validateConfig(defaultConfig()).ok, true);
  });
});

describe('normaliseConfig', () => {
  it('falls back to safe defaults for missing or junk input', () => {
    const result = normaliseConfig(undefined);
    assert.equal(result.period, PERIOD.LAST_WEEK);
    assert.deepEqual(result.enabledProjects, []);

    const junk = normaliseConfig({ period: 'nonsense', enforcementGraceHours: 'abc', enabledProjects: 'no' });
    assert.equal(junk.period, PERIOD.LAST_WEEK);
    assert.equal(junk.enforcementGraceHours, 48);
    assert.deepEqual(junk.enabledProjects, []);
  });

  it('defaults every project to disabled — enforcement is opt-in', () => {
    assert.deepEqual(defaultConfig().enabledProjects, []);
  });

  it('de-duplicates project keys', () => {
    assert.deepEqual(normaliseConfig({ enabledProjects: ['AB', 'AB', 'CD'] }).enabledProjects, [
      'AB',
      'CD',
    ]);
  });
});

/* -------------------------------------------------------------------- statuses -- */

describe('dedupeStatuses', () => {
  it('collapses duplicate and case-variant names, keeping the first id', () => {
    const result = dedupeStatuses([
      { id: '1', name: 'In progress' },
      { id: '2', name: 'In Progress' },
      { id: '3', name: 'in progress ' },
      { id: '4', name: 'Done' },
      { id: '5', name: 'Done' },
    ]);
    assert.deepEqual(result, [
      { id: '4', name: 'Done' },
      { id: '1', name: 'In progress' },
    ]);
  });

  it('drops entries with no usable name', () => {
    assert.deepEqual(dedupeStatuses([{ id: '1', name: '  ' }, { id: '2' }]), []);
  });
});

/* ---------------------------------------------------------- comment rendering -- */

describe('renderCommentTemplate', () => {
  it('substitutes tokens without emitting a stray @', () => {
    const text = renderCommentTemplate(
      '[System Notification] {{authorName}} Your worklog on {{worklogDate}} was removed.',
      { authorName: 'Ravi Acharya', worklogDate: 'July 1, 2026' },
    );
    assert.equal(text, '[System Notification] Ravi Acharya Your worklog on July 1, 2026 was removed.');
    assert.ok(!text.includes('@'), 'comment must not contain an @mention');
  });

  it('leaves unknown tokens untouched', () => {
    assert.match(renderCommentTemplate('Hi {{nope}}', {}), /\{\{nope\}\}/);
  });

  it('collapses the gap left by an empty value', () => {
    assert.equal(renderCommentTemplate('a {{authorName}} b', { authorName: '' }), 'a b');
  });
});

/* ------------------------------------------------------------------ log stats -- */

describe('summariseRemovals', () => {
  const now = new Date('2026-08-19T12:00:00Z');
  const entries = [
    { issueKey: 'POC-45', authorDisplayName: 'Ravi Acharya', removedAt: iso('2026-08-02T00:00:00Z') },
    { issueKey: 'POC-45', authorDisplayName: 'Ravi Acharya', removedAt: iso('2026-08-11T00:00:00Z') },
    { issueKey: 'POC-46', authorDisplayName: 'Asha Rao', removedAt: iso('2026-08-12T00:00:00Z') },
    { issueKey: 'POC-99', authorDisplayName: 'Old Entry', removedAt: iso('2026-07-30T00:00:00Z') },
  ];

  it('counts only the current calendar month and names it', () => {
    const stats = summariseRemovals(entries, now);
    assert.equal(stats.removedThisMonth, 3);
    assert.equal(stats.issuesAffected, 2);
    assert.equal(stats.scopeLabel, 'August 2026');
  });

  it('picks the author with the most removals this month', () => {
    assert.equal(summariseRemovals(entries, now).topAuthor, 'Ravi Acharya');
  });

  it('returns a null top author rather than a blank one when empty', () => {
    const stats = summariseRemovals([], now);
    assert.equal(stats.topAuthor, null);
    assert.equal(stats.removedThisMonth, 0);
  });
});

/* ------------------------------------------------------------------ countdown -- */

describe('humaniseCountdown', () => {
  const from = new Date('2026-08-19T12:00:00Z');

  it('describes the remaining window in sensible units', () => {
    assert.equal(humaniseCountdown(from, '2026-08-19T12:30:00Z'), 'in 30 minutes');
    assert.equal(humaniseCountdown(from, '2026-08-20T00:00:00Z'), 'in 12 hours');
    assert.equal(humaniseCountdown(from, '2026-08-22T12:00:00Z'), 'in 3 days');
  });

  it('says imminently once the deadline has passed', () => {
    assert.equal(humaniseCountdown(from, '2026-08-19T11:00:00Z'), 'imminently');
  });
});

/* ------------------------------------------------- grandfathering pre-existing -- */

describe('grandfathering worklogs that predate the rule', () => {
  const activated = '2026-08-20T10:00:00Z';
  const rule = config({
    period: PERIOD.LAST_WEEK,
    enforcementGraceHours: 0,
    effectiveFrom: activated,
  });

  // Logged BEFORE the policy existed, for a period the policy would forbid.
  const preExisting = { id: 'old', started: iso('2026-06-01T00:00:00Z'), created: iso('2026-06-01T09:00:00Z') };
  // Logged AFTER the policy came into force, backdated to June.
  const backdatedAfter = { id: 'new', started: iso('2026-06-01T00:00:00Z'), created: iso('2026-08-20T11:00:00Z') };

  it('exempts a worklog logged before the rule took effect', () => {
    assert.equal(isGrandfathered(preExisting, rule), true);
    const { results } = classifyWorklogs({
      worklogs: [preExisting],
      config: rule,
      now: new Date('2026-08-20T12:00:00Z'),
    });
    assert.equal(results[0].state, STATE.EXEMPT);
    assert.equal(results[0].enforceAt, null, 'must never acquire a deletion deadline');
  });

  it('still enforces a backdated worklog logged after the rule took effect', () => {
    assert.equal(isGrandfathered(backdatedAfter, rule), false);
    const { results } = classifyWorklogs({
      worklogs: [backdatedAfter],
      config: rule,
      now: new Date('2026-08-20T12:00:00Z'),
    });
    assert.equal(results[0].state, STATE.ENFORCE);
  });

  it('treats an undateable worklog as pre-existing rather than deleting it', () => {
    assert.equal(isGrandfathered({ id: 'x', started: iso('2026-06-01T00:00:00Z') }, rule), true);
  });

  it('enforces everything when no activation stamp is set yet', () => {
    // Legacy config with no effectiveFrom must not silently exempt everything.
    assert.equal(isGrandfathered(preExisting, config({ period: PERIOD.LAST_WEEK })), false);
  });
});

/* ---------------------------------------------------------- jira datetime fmt -- */

describe('toJiraDateTime', () => {
  it('emits milliseconds and a numeric offset, not a bare Z', () => {
    const out = toJiraDateTime('2026-06-01T09:00:00Z');
    assert.equal(out, '2026-06-01T09:00:00.000+0000');
    assert.ok(!out.endsWith('Z'), 'a trailing Z is rejected by the worklog API');
    assert.match(out, /\.\d{3}\+0000$/);
  });

  it('normalises an offset-bearing input to UTC', () => {
    assert.equal(toJiraDateTime('2026-06-01T14:30:00+05:30'), '2026-06-01T09:00:00.000+0000');
  });

  it('returns null for an unparseable value rather than a bad string', () => {
    assert.equal(toJiraDateTime('not a date'), null);
    assert.equal(toJiraDateTime(null), null);
  });
});

/* --------------------------------------------------- flag-mode notification -- */

describe('flag-mode comment', () => {
  it('defaults to notifying, with wording that does not claim a deletion', () => {
    const c = defaultConfig();
    assert.equal(c.commentOnFlag, true);
    assert.match(c.flagCommentTemplate, /NOT been removed/);
    assert.ok(!/has been\s+automatically removed/.test(c.flagCommentTemplate));
  });

  it('renders the flag template with a real mention so the author is emailed', () => {
    const doc = buildCommentDocument(
      defaultConfig().flagCommentTemplate,
      { authorName: 'Ada Lovelace', worklogDate: 'June 3, 2026' },
      { accountId: 'acct-9', displayName: 'Ada Lovelace' },
    );
    const nodes = doc.content[0].content;
    const mentions = nodes.filter((n) => n.type === 'mention');
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0].attrs.id, 'acct-9');
    const text = nodes.map((n) => (n.type === 'mention' ? n.attrs.text : n.text)).join('');
    assert.match(text, /June 3, 2026/);
    assert.match(text, /NOT been removed/);
  });

  it('rejects an empty flag template only while flag notifications are on', () => {
    const on = validateConfig(
      config({ action: ACTION.FLAG, commentOnFlag: true, flagCommentTemplate: '   ' }),
    );
    assert.equal(on.ok, false);
    assert.ok(on.errors.flagCommentTemplate);

    const off = validateConfig(
      config({ action: ACTION.FLAG, commentOnFlag: false, flagCommentTemplate: '   ' }),
    );
    assert.equal(off.ok, true, 'template is irrelevant when notifications are off');
  });

  it('does not let the delete-mode template block a flag-mode save', () => {
    const result = validateConfig(config({ action: ACTION.FLAG, commentTemplate: '' }));
    assert.equal(result.ok, true);
  });

  it('preserves commentOnFlag=false through normalisation', () => {
    assert.equal(normaliseConfig({ commentOnFlag: false }).commentOnFlag, false);
    assert.equal(normaliseConfig({}).commentOnFlag, true);
  });
});

/* --------------------------------------------------------- rule explanation -- */

describe('describePeriod', () => {
  // The exact question that prompted this: today is 16 Sep 2026, so what
  // happens to August?
  const sept16 = new Date('2026-09-16T12:00:00Z');

  it('states that the previous calendar month is CLOSED, not still open', () => {
    const { allows, blocks } = describePeriod(config({ period: PERIOD.LAST_MONTH }), sept16);
    assert.match(allows, /September 2026/);
    assert.match(allows, /current calendar month only/);
    assert.match(blocks, /^August 2026 and everything earlier/);
  });

  it('names the date the month window rolls forward', () => {
    const { blocks } = describePeriod(config({ period: PERIOD.LAST_MONTH }), sept16);
    assert.match(blocks, /Oct 1, 2026/);
    assert.match(blocks, /September 2026 closes too/);
  });

  it('crosses the year boundary correctly', () => {
    const jan = new Date('2026-01-15T12:00:00Z');
    const { allows, blocks } = describePeriod(config({ period: PERIOD.LAST_MONTH }), jan);
    assert.match(allows, /January 2026/);
    assert.match(blocks, /December 2025/);
    assert.match(blocks, /Feb 1, 2026/);
  });

  it('agrees with what classifyWorklogs actually does', () => {
    // The explanation and the rule must not drift apart. August is described as
    // blocked, so August had better classify as ENFORCE.
    const cfg = config({ period: PERIOD.LAST_MONTH, enforcementGraceHours: 48 });
    const { results } = classifyWorklogs({
      worklogs: [worklog('a', '2026-08-15T09:00:00Z'), worklog('b', '2026-09-03T09:00:00Z')],
      config: cfg,
      now: sept16,
    });
    assert.equal(results[0].state, STATE.ENFORCE, 'August should be blocked');
    assert.equal(results[1].state, STATE.COMPLIANT, 'September should be allowed');
    assert.match(describePeriod(cfg, sept16).blocks, /August 2026/);
  });

  it('describes the calendar-year rule against the current year', () => {
    const { allows, blocks } = describePeriod(config({ period: PERIOD.LAST_YEAR }), sept16);
    assert.match(allows, /2026 — the current calendar year only/);
    assert.match(blocks, /2025 and everything earlier/);
    assert.match(blocks, /1 Jan 2027/);
  });

  it('gives the rolling week an explicit cutoff date and says it moves hourly', () => {
    const { allows, blocks } = describePeriod(config({ period: PERIOD.LAST_WEEK }), sept16);
    assert.match(allows, /Sep 9, 2026/);
    assert.match(blocks, /to the hour, not the calendar day/);
  });

  it('warns that the transition rule matches nothing without a status', () => {
    const { blocks } = describePeriod(
      config({ period: PERIOD.AFTER_TRANSITION, targetStatusName: null }),
      sept16,
    );
    assert.match(blocks, /can never match/);
  });

  it('names the status, the grace and the reopen behaviour once configured', () => {
    const { allows, blocks } = describePeriod(
      config({
        period: PERIOD.AFTER_TRANSITION,
        targetStatusName: 'Done',
        transitionGraceHours: 24,
        resetOnReopen: true,
      }),
      sept16,
    );
    assert.match(allows, /"Done"/);
    assert.match(allows, /plus 24 hours afterwards/);
    assert.match(blocks, /Re-opening an issue lifts the restriction/);
  });

  it('omits the reopen sentence when reset-on-reopen is off', () => {
    const { blocks } = describePeriod(
      config({ period: PERIOD.AFTER_TRANSITION, targetStatusName: 'Done', resetOnReopen: false }),
      sept16,
    );
    assert.ok(!blocks.includes('Re-opening'));
  });
});

describe('period labels', () => {
  it('says "calendar" where the rule is a calendar comparison', () => {
    assert.equal(PERIOD_LABELS[PERIOD.LAST_MONTH], 'Last Calendar Month');
    assert.equal(PERIOD_LABELS[PERIOD.LAST_YEAR], 'Last Calendar Year');
  });

  it('leaves the rolling week label alone — it is not a calendar rule', () => {
    assert.equal(PERIOD_LABELS[PERIOD.LAST_WEEK], 'Last 1 Week');
  });
});
