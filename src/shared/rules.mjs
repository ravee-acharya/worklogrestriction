// Pure domain logic. No Jira calls, no storage, no DOM — so both the resolvers
// and the two frontends import the same rules, and the whole thing is unit
// testable with plain `node --test`.

export const PERIOD = {
  LAST_WEEK: 'last_week',
  LAST_MONTH: 'last_month',
  LAST_YEAR: 'last_year',
  AFTER_TRANSITION: 'after_transition',
};

// Display text only — never compared, never used as a key. The stored config
// key is the PERIOD value, so these can be reworded without a migration.
//
// "Calendar" is in two of these because the distinction is the thing admins get
// wrong: the month and year rules are calendar comparisons, not rolling 30- or
// 365-day windows. Under "Last Calendar Month", work dated in the previous
// month is already closed — it does not stay open for another month.
export const PERIOD_LABELS = {
  [PERIOD.LAST_WEEK]: 'Last 1 Week',
  [PERIOD.LAST_MONTH]: 'Last Calendar Month',
  [PERIOD.LAST_YEAR]: 'Last Calendar Year',
  [PERIOD.AFTER_TRANSITION]: 'After Status Transition',
};

export const ACTION = {
  DELETE: 'delete',
  FLAG: 'flag',
};

export const ACTION_LABELS = {
  [ACTION.DELETE]: 'Delete worklog and post system comment to author',
  [ACTION.FLAG]: 'Flag only — notify admin for manual review',
};

/** Options for the per-transition grace, in hours. */
export const TRANSITION_GRACE_OPTIONS = [
  { value: 0, label: 'No grace period' },
  { value: 24, label: '24 hours' },
  { value: 48, label: '48 hours' },
  { value: 168, label: '7 days' },
];

/** Options for the global "hold off before enforcing" grace, in hours. */
export const ENFORCEMENT_GRACE_OPTIONS = [
  { value: 0, label: 'No grace period' },
  { value: 24, label: '24 hours' },
  { value: 48, label: '48 hours' },
  { value: 168, label: '7 days' },
];

/**
 * The same grace expressed in working days, Mon–Fri.
 *
 * Elapsed hours are the wrong unit for a month-end close: a 48-hour window that
 * starts on a Saturday is over before anybody is at their desk. Counting only
 * working days makes "four days to fix your timesheet" mean four days on which
 * someone could actually have done it.
 */
export const ENFORCEMENT_GRACE_WORKING_DAY_OPTIONS = [
  { value: 1, label: '1 working day' },
  { value: 2, label: '2 working days' },
  { value: 3, label: '3 working days' },
  { value: 4, label: '4 working days' },
  { value: 5, label: '5 working days' },
  { value: 10, label: '10 working days' },
];

/**
 * The two grace families as one list for a single dropdown.
 *
 * Tokens (`h:48`, `wd:4`) exist only in the UI. The stored config keeps two
 * plain fields, so nothing about the wire format depends on this encoding.
 */
export function graceOptions() {
  return [
    ...ENFORCEMENT_GRACE_OPTIONS.map((option) => ({
      value: `h:${option.value}`,
      label: option.label,
    })),
    ...ENFORCEMENT_GRACE_WORKING_DAY_OPTIONS.map((option) => ({
      value: `wd:${option.value}`,
      label: option.label,
    })),
  ];
}

/** Current config -> dropdown token. */
export function graceToken(config) {
  const days = Number(config?.enforcementGraceWorkingDays);
  if (Number.isFinite(days) && days > 0) return `wd:${days}`;
  return `h:${Number(config?.enforcementGraceHours) || 0}`;
}

/** Dropdown token -> the config fields it sets. Always sets both, so switching
 *  families cannot leave the abandoned one lying around still active. */
export function graceFromToken(token) {
  const [unit, raw] = String(token ?? '').split(':');
  const value = Number(raw);
  if (unit === 'wd' && Number.isFinite(value) && value > 0) {
    return { enforcementGraceHours: 0, enforcementGraceWorkingDays: value };
  }
  return {
    enforcementGraceHours: Number.isFinite(value) ? value : 0,
    enforcementGraceWorkingDays: null,
  };
}

export const DEFAULT_COMMENT_TEMPLATE =
  '[System Notification] {{authorName}} Your worklog on {{worklogDate}} has been ' +
  "automatically removed because it violates the company's historical time-logging " +
  'restrictions.';

/**
 * Flag-only mode posts this instead. Deliberately different wording: nothing has
 * been removed, so a message saying otherwise would be alarming and wrong.
 */
export const DEFAULT_FLAG_COMMENT_TEMPLATE =
  '[System Notification] {{authorName}} Your worklog on {{worklogDate}} falls outside ' +
  "the company's historical time-logging restrictions and has been flagged for " +
  'review. It has NOT been removed.';

export const COMMENT_TOKENS = [
  'authorName',
  'worklogDate',
  'issueKey',
  'issueSummary',
  'restrictionRule',
  'projectName',
];

export const COMMENT_TEMPLATE_MAX = 500;

/**
 * The shape written to KVS. Everything that follows assumes these defaults, so
 * a missing or partial stored object still produces a safe, inert config.
 */
export function defaultConfig() {
  return {
    period: PERIOD.LAST_WEEK,
    targetStatusId: null,
    targetStatusName: null,
    transitionGraceHours: 0,
    resetOnReopen: true,
    enforcementGraceHours: 48,
    // When set to a positive number this replaces the hours grace entirely.
    // Null means "use hours", which is what every config written before this
    // option existed will normalise to.
    enforcementGraceWorkingDays: null,
    commentTemplate: DEFAULT_COMMENT_TEMPLATE,
    flagCommentTemplate: DEFAULT_FLAG_COMMENT_TEMPLATE,
    // Whether flagging also tells the author. Flagging used to be silent, so a
    // worklog could sit flagged indefinitely with nobody but an admin aware.
    commentOnFlag: true,
    action: ACTION.DELETE,
    enabledProjects: [],
    // Worklogs LOGGED before this instant are exempt. Stamped when the rules
    // are saved, so switching the policy on does not retroactively punish
    // history that was already recorded under the old (absent) policy.
    effectiveFrom: null,
  };
}

const DAY_MS = 86400000;
const HOUR_MS = 3600000;

/* -------------------------------------------------------------- validation -- */

/**
 * Rejects configurations that would silently enforce nothing.
 *
 * The old console happily saved "After Status Transition" with no target status
 * and reported success — a live rule that could never match anything. Both the
 * frontend and `saveConfig` run this, so the bad state cannot be reached from
 * either direction.
 *
 * @returns {{ok: boolean, errors: Record<string, string>}}
 */
export function validateConfig(config) {
  const errors = {};
  const periods = Object.values(PERIOD);

  if (!periods.includes(config.period)) {
    errors.period = 'Choose a restriction period.';
  }

  if (config.period === PERIOD.AFTER_TRANSITION) {
    if (!config.targetStatusName) {
      errors.targetStatusName =
        'Choose the status that starts the restriction. Without it this rule can never match, so nothing would be enforced.';
    }
    if (!TRANSITION_GRACE_OPTIONS.some((o) => o.value === config.transitionGraceHours)) {
      errors.transitionGraceHours = 'Choose a grace period.';
    }
  }

  if (usesWorkingDayGrace(config)) {
    if (
      !ENFORCEMENT_GRACE_WORKING_DAY_OPTIONS.some(
        (o) => o.value === config.enforcementGraceWorkingDays,
      )
    ) {
      errors.enforcementGraceWorkingDays = 'Choose a grace period.';
    }
  } else if (!ENFORCEMENT_GRACE_OPTIONS.some((o) => o.value === config.enforcementGraceHours)) {
    errors.enforcementGraceHours = 'Choose a grace period.';
  }

  if (!Object.values(ACTION).includes(config.action)) {
    errors.action = 'Choose an enforcement action.';
  }

  const template = String(config.commentTemplate ?? '');
  if (config.action === ACTION.DELETE) {
    if (!template.trim()) {
      errors.commentTemplate = 'The comment template cannot be empty in delete mode.';
    } else if (template.length > COMMENT_TEMPLATE_MAX) {
      errors.commentTemplate = `Keep the template to ${COMMENT_TEMPLATE_MAX} characters or fewer.`;
    }
  }

  const flagTemplate = String(config.flagCommentTemplate ?? '');
  if (config.action === ACTION.FLAG && config.commentOnFlag) {
    if (!flagTemplate.trim()) {
      errors.flagCommentTemplate =
        'The flag comment template cannot be empty while flag notifications are on.';
    } else if (flagTemplate.length > COMMENT_TEMPLATE_MAX) {
      errors.flagCommentTemplate = `Keep the template to ${COMMENT_TEMPLATE_MAX} characters or fewer.`;
    }
  }

  if (!Array.isArray(config.enabledProjects)) {
    errors.enabledProjects = 'Enabled projects must be a list of project keys.';
  }

  return { ok: Object.keys(errors).length === 0, errors };
}

/** Coerces an arbitrary stored/posted object into a well-typed config. */
export function normaliseConfig(raw) {
  const base = defaultConfig();
  if (!raw || typeof raw !== 'object') return base;

  const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

  return {
    period: Object.values(PERIOD).includes(raw.period) ? raw.period : base.period,
    targetStatusId: raw.targetStatusId ? String(raw.targetStatusId) : null,
    targetStatusName: raw.targetStatusName ? String(raw.targetStatusName) : null,
    transitionGraceHours: num(raw.transitionGraceHours, base.transitionGraceHours),
    resetOnReopen: raw.resetOnReopen !== false,
    enforcementGraceHours: num(raw.enforcementGraceHours, base.enforcementGraceHours),
    // Only a positive number switches to working days; anything else (absent,
    // null, 0, junk) means the hours grace stays in charge.
    enforcementGraceWorkingDays:
      Number.isFinite(Number(raw.enforcementGraceWorkingDays)) &&
      Number(raw.enforcementGraceWorkingDays) > 0
        ? Math.floor(Number(raw.enforcementGraceWorkingDays))
        : null,
    commentTemplate:
      typeof raw.commentTemplate === 'string' && raw.commentTemplate.trim()
        ? raw.commentTemplate.slice(0, COMMENT_TEMPLATE_MAX)
        : base.commentTemplate,
    flagCommentTemplate:
      typeof raw.flagCommentTemplate === 'string' && raw.flagCommentTemplate.trim()
        ? raw.flagCommentTemplate.slice(0, COMMENT_TEMPLATE_MAX)
        : base.flagCommentTemplate,
    commentOnFlag: raw.commentOnFlag !== false,
    action: Object.values(ACTION).includes(raw.action) ? raw.action : base.action,
    enabledProjects: Array.isArray(raw.enabledProjects)
      ? [...new Set(raw.enabledProjects.map(String))]
      : [],
    effectiveFrom: raw.effectiveFrom ? String(raw.effectiveFrom) : null,
  };
}

/**
 * Whether a worklog predates the policy and is therefore exempt.
 *
 * Compares the worklog's CREATION time (when it was logged) against the rule's
 * activation, not the period it claims to cover. A worklog logged last March
 * for last March was compliant with the rules in force at the time; turning a
 * restriction on today must not make it retroactively deletable.
 *
 * Fails safe: a worklog whose creation time is unknown is treated as
 * pre-existing, because deleting something undateable is unrecoverable.
 */
export function isGrandfathered(worklog, config) {
  if (!config?.effectiveFrom) return false;
  const from = parseDate(config.effectiveFrom);
  if (!from) return false;
  const created = parseDate(worklog?.created);
  if (!created) return true;
  return created.getTime() < from.getTime();
}

/**
 * True when the config is structurally valid AND would actually do something.
 * Drives the "this configuration is inactive" warning on Validator Preview.
 */
export function isConfigActive(config) {
  return validateConfig(config).ok && config.enabledProjects.length > 0;
}

/* ---------------------------------------------------------- status helpers -- */

const statusKey = (name) => String(name ?? '').trim().toLowerCase();

/**
 * Jira returns one status row per workflow, so a site can legitimately show
 * "In progress" a dozen times. Matching is by name, which means those rows are
 * indistinguishable to this app — collapse them so the admin is not asked to
 * pick between identical options.
 */
export function dedupeStatuses(statuses) {
  const seen = new Map();
  for (const status of statuses ?? []) {
    const key = statusKey(status?.name);
    if (!key || seen.has(key)) continue;
    seen.set(key, { id: String(status.id), name: String(status.name).trim() });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function statusNamesMatch(a, b) {
  return statusKey(a) === statusKey(b) && statusKey(a) !== '';
}

/* ------------------------------------------------------------ date helpers -- */

function parseDate(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/* --------------------------------------------------------- working days -- */

/** Saturday and Sunday. Public holidays are NOT excluded — see the note on
 *  `addWorkingDays`. */
function isWeekend(date) {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

/**
 * The instant at which `days` whole working days have elapsed after `from`.
 *
 * Counting rules, stated because month-end boundaries land on weekends often
 * enough that guessing is not good enough:
 *
 *  - A day counts only if it is Mon–Fri.
 *  - A partial day does not count. If `from` is mid-afternoon, counting starts
 *    the following day — the remaining hours are a bonus, not day one. Calendar
 *    month breaches land exactly on midnight, so they do count that day.
 *  - The deadline is the END of the last working day, i.e. midnight at the
 *    start of the next calendar day.
 *
 * Worked example, which is the case this was built for: August 2026 closes at
 * 1 Sep 00:00 UTC, a Tuesday. Four working days are Tue 1, Wed 2, Thu 3, Fri 4,
 * so enforcement begins Sat 5 Sep 00:00 UTC. When the 1st is a Saturday the
 * weekend is skipped and counting starts on the Monday.
 *
 * Public holidays are deliberately not modelled. Jira has no holiday calendar
 * to read, and hard-coding one region's holidays into a rule that applies
 * site-wide would be wrong for everyone else. The effect is that a grace window
 * spanning a holiday is shorter in practice than it looks — worth allowing for
 * when choosing the number of days.
 *
 * @param {Date} from
 * @param {number} days
 * @returns {Date}
 */
export function addWorkingDays(from, days) {
  const start = from instanceof Date ? from : new Date(from);
  if (Number.isNaN(start.getTime())) return start;

  const wanted = Math.max(0, Math.floor(Number(days) || 0));

  // Midnight of the day containing `from`.
  const cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );

  if (wanted === 0) return start;

  // A partial first day does not count as a working day.
  if (start.getTime() > cursor.getTime()) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  let counted = 0;
  // Bounded rather than `while (true)`: 10 working days can never need more
  // than a few weeks, and an unbounded loop in shared code is a hazard.
  for (let guard = 0; guard < 400 && counted < wanted; guard += 1) {
    if (!isWeekend(cursor)) counted += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  // `cursor` has already advanced past the final counted day, so it is sitting
  // on midnight at the end of it — which is the deadline.
  return cursor;
}

/** Whether this config expresses its grace in working days rather than hours. */
export function usesWorkingDayGrace(config) {
  const days = Number(config?.enforcementGraceWorkingDays);
  return Number.isFinite(days) && days > 0;
}

/** Applies whichever grace the config uses to a breach instant. */
export function applyGrace(since, config) {
  if (usesWorkingDayGrace(config)) {
    return addWorkingDays(since, config.enforcementGraceWorkingDays);
  }
  return new Date(since.getTime() + (Number(config?.enforcementGraceHours) || 0) * HOUR_MS);
}

/* ------------------------------------------------- transition lock resolver -- */

/**
 * Finds when the issue became locked, per the "After Status Transition" rule.
 *
 * Walks the status history oldest-first and keeps the most recent inward
 * transition to the target status. When resetOnReopen is on, a later transition
 * *out of* the target clears the lock again, so re-opened issues can be logged
 * against until they re-enter the target status.
 *
 * @returns {{lockedAt: Date, lockTime: Date}|null} null when not locked.
 */
export function resolveTransitionLock(changelog, config) {
  if (!config.targetStatusName) return null;

  const entries = (changelog ?? [])
    .flatMap((entry) => {
      const created = parseDate(entry?.created);
      if (!created) return [];
      return (entry.items ?? [])
        .filter((item) => String(item?.field ?? '').toLowerCase() === 'status')
        .map((item) => ({ created, from: item.fromString, to: item.toString }));
    })
    .sort((a, b) => a.created - b.created);

  let lockedAt = null;
  for (const entry of entries) {
    if (statusNamesMatch(entry.to, config.targetStatusName)) {
      lockedAt = entry.created;
    } else if (config.resetOnReopen && statusNamesMatch(entry.from, config.targetStatusName)) {
      lockedAt = null;
    }
  }

  if (!lockedAt) return null;

  return {
    lockedAt,
    lockTime: new Date(lockedAt.getTime() + config.transitionGraceHours * HOUR_MS),
  };
}

/* ------------------------------------------------------ violation evaluation -- */

/**
 * Decides whether one worklog breaks the active rule.
 *
 * @returns {{violation: boolean, rule: string|null, detail: object}}
 */
export function evaluateWorklog({ worklog, config, changelog, now = new Date() }) {
  const started = parseDate(worklog?.started);
  const rule = PERIOD_LABELS[config.period] ?? null;
  const none = { violation: false, rule, detail: {} };

  if (!started) return none;

  switch (config.period) {
    case PERIOD.LAST_WEEK:
      return {
        violation: now.getTime() - started.getTime() > 7 * DAY_MS,
        rule,
        detail: {},
      };

    case PERIOD.LAST_MONTH: {
      const startedMonths = started.getUTCFullYear() * 12 + started.getUTCMonth();
      const nowMonths = now.getUTCFullYear() * 12 + now.getUTCMonth();
      return { violation: startedMonths < nowMonths, rule, detail: {} };
    }

    case PERIOD.LAST_YEAR:
      return {
        violation: started.getUTCFullYear() < now.getUTCFullYear(),
        rule,
        detail: {},
      };

    case PERIOD.AFTER_TRANSITION: {
      const lock = resolveTransitionLock(changelog, config);
      if (!lock) return none;
      return {
        violation: started.getTime() > lock.lockTime.getTime(),
        rule,
        detail: {
          targetStatusName: config.targetStatusName,
          transitionedAt: lock.lockedAt.toISOString(),
          lockTime: lock.lockTime.toISOString(),
        },
      };
    }

    default:
      return none;
  }
}

/**
 * The instant a worklog first breached the active rule.
 *
 * Derived from the worklog and the rule alone — never from when this app
 * happened to look at it. That distinction is the whole point: anchoring to
 * first-sighting meant installing the app, or enabling a project, silently
 * granted every pre-existing violation a fresh grace window. A worklog that
 * has been out of policy for six months is not owed 48 more hours.
 *
 * @returns {Date|null} null when the rule cannot place the breach in time.
 */
export function violationSince({ worklog, config, changelog }) {
  const started = parseDate(worklog?.started);
  if (!started) return null;

  switch (config.period) {
    case PERIOD.LAST_WEEK:
      // The predicate is `now - started > 7 days`, so it flips true exactly here.
      return new Date(started.getTime() + 7 * DAY_MS);

    case PERIOD.LAST_MONTH:
      // Breaches the moment the calendar month after `started` begins.
      return new Date(Date.UTC(started.getUTCFullYear(), started.getUTCMonth() + 1, 1));

    case PERIOD.LAST_YEAR:
      return new Date(Date.UTC(started.getUTCFullYear() + 1, 0, 1));

    case PERIOD.AFTER_TRANSITION: {
      const lock = resolveTransitionLock(changelog, config);
      if (!lock) return null;
      // Two facts must both hold: the issue is locked, and the worklog exists.
      // Whichever happened later is when the breach began.
      const created = parseDate(worklog?.created) ?? started;
      return new Date(Math.max(lock.lockTime.getTime(), created.getTime()));
    }

    default:
      return null;
  }
}

/* ----------------------------------------------------------- classification -- */

export const STATE = {
  COMPLIANT: 'compliant',
  /** Breaches the rule, but was logged before the rule took effect. */
  EXEMPT: 'exempt',
  GRACE: 'grace',
  ENFORCE: 'enforce',
};

/**
 * Turns a list of worklogs into per-worklog verdicts.
 *
 * The enforcement grace runs from when the worklog objectively breached the
 * rule — `violationSince` — plus the configured hours. It is a pure function of
 * the worklog, the rule and the config, so the deadline is identical no matter
 * when or how often anything evaluates it, and a long-stale violation is due
 * for enforcement the moment the app first sees it rather than getting a fresh
 * reprieve.
 *
 * @param {object}  args
 * @param {Array}   args.worklogs    Jira worklog objects.
 * @param {object}  args.config      Normalised config.
 * @param {Array}   args.changelog   Status history (transition mode only).
 * @param {Date}    args.now
 * @returns {{results: Array}}
 */
export function classifyWorklogs({ worklogs = [], config, changelog = [], now = new Date() }) {
  const results = [];

  for (const worklog of worklogs) {
    const { violation, rule, detail } = evaluateWorklog({ worklog, config, changelog, now });

    if (!violation) {
      results.push({
        worklog,
        state: STATE.COMPLIANT,
        rule,
        detail,
        violationSince: null,
        enforceAt: null,
      });
      continue;
    }

    const since = violationSince({ worklog, config, changelog });

    if (isGrandfathered(worklog, config)) {
      results.push({
        worklog,
        state: STATE.EXEMPT,
        rule,
        detail,
        violationSince: since ? since.toISOString() : null,
        enforceAt: null,
      });
      continue;
    }

    // A rule that cannot place the breach in time gets no grace rather than
    // infinite grace — it is already a confirmed violation.
    const enforceAt = since ? applyGrace(since, config) : now;

    results.push({
      worklog,
      state: now.getTime() >= enforceAt.getTime() ? STATE.ENFORCE : STATE.GRACE,
      rule,
      detail,
      violationSince: since ? since.toISOString() : null,
      enforceAt: enforceAt.toISOString(),
    });
  }

  return { results };
}

/** "in 2 days" / "in 3 hours" / "in 12 minutes" for the panel banner. */
export function humaniseCountdown(fromDate, toDate) {
  const from = parseDate(fromDate);
  const to = parseDate(toDate);
  if (!from || !to) return 'imminently';

  const ms = to.getTime() - from.getTime();
  if (ms <= 0) return 'imminently';

  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;

  const hours = Math.round(ms / HOUR_MS);
  if (hours < 48) return `in ${hours} hour${hours === 1 ? '' : 's'}`;

  const days = Math.round(ms / DAY_MS);
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

/* -------------------------------------------------------- rule explanation -- */

const utcMonth = (date) =>
  date.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

const utcDay = (date) =>
  date.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * Plain-English, date-specific description of what the selected rule does.
 *
 * Exists because the labels alone are genuinely ambiguous: "Last Calendar
 * Month" can be read as "the previous month is closed" or "the previous month
 * is still open", and those are opposite policies that differ by a whole month
 * of timesheets. Rather than argue about naming, the console states the answer
 * against today's actual date.
 *
 * Pure, and takes `now`, so it is testable and cannot drift from the rules it
 * describes — both live in this file.
 *
 * @returns {{allows: string, blocks: string}}
 */
export function describePeriod(config, now = new Date()) {
  switch (config?.period) {
    case PERIOD.LAST_WEEK: {
      const cutoff = new Date(now.getTime() - 7 * DAY_MS);
      return {
        allows: `Work dated within the last 7 days — currently back to ${utcDay(cutoff)}.`,
        blocks: `Anything older. Measured to the hour, not the calendar day, so this boundary moves continuously.`,
      };
    }

    case PERIOD.LAST_MONTH: {
      const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const prevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      return {
        allows: `Work dated in ${utcMonth(thisMonth)} — the current calendar month only.`,
        blocks: `${utcMonth(prevMonth)} and everything earlier. On ${utcDay(nextMonth)} the window rolls forward and ${utcMonth(thisMonth)} closes too.`,
      };
    }

    case PERIOD.LAST_YEAR: {
      const year = now.getUTCFullYear();
      return {
        allows: `Work dated in ${year} — the current calendar year only.`,
        blocks: `${year - 1} and everything earlier. On 1 Jan ${year + 1} the window rolls forward and ${year} closes too.`,
      };
    }

    case PERIOD.AFTER_TRANSITION: {
      if (!config.targetStatusName) {
        return {
          allows: 'Nothing is restricted yet.',
          blocks: 'Choose a status below. Until you do, this rule can never match and nothing will be enforced.',
        };
      }
      const hours = config.transitionGraceHours;
      const grace = hours > 0 ? `, plus ${hours} hour${hours === 1 ? '' : 's'} afterwards` : '';
      return {
        allows: `Work logged before an issue reaches "${config.targetStatusName}"${grace}.`,
        blocks: `Work logged after that, on issues that have reached "${config.targetStatusName}".${
          config.resetOnReopen ? ' Re-opening an issue lifts the restriction until it returns to that status.' : ''
        }`,
      };
    }

    default:
      return { allows: '', blocks: '' };
  }
}

const utcDated = (date) =>
  date.toLocaleDateString('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

/**
 * States the grace window and the concrete deadline it produces.
 *
 * Working-day arithmetic is exactly the kind of thing everyone agrees on in the
 * abstract and disagrees on in practice — does the 1st count, what if it is a
 * Saturday — so the console shows the resulting date rather than the rule.
 *
 * @returns {{window: string, deadline: string}}
 */
export function describeGrace(config, now = new Date()) {
  const workingDays = usesWorkingDayGrace(config) ? config.enforcementGraceWorkingDays : null;
  const hours = Number(config?.enforcementGraceHours) || 0;

  const window = workingDays
    ? `${workingDays} working day${workingDays === 1 ? '' : 's'}, counting Monday to Friday only. ` +
      `Weekends are skipped. Public holidays are not excluded — Jira has no holiday calendar to read.`
    : hours === 0
      ? 'None. A worklog is enforced the moment it breaches.'
      : `${hours} hour${hours === 1 ? '' : 's'} of elapsed time, weekends included.`;

  let breach = null;
  let subject = null;

  switch (config?.period) {
    case PERIOD.LAST_MONTH: {
      breach = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      subject = `Work dated in ${utcMonth(prev)}`;
      break;
    }
    case PERIOD.LAST_YEAR: {
      breach = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      subject = `Work dated in ${now.getUTCFullYear() - 1}`;
      break;
    }
    default:
      breach = now;
      subject = 'A worklog breaching right now';
      break;
  }

  const enforceAt = applyGrace(breach, config);
  const deadline =
    enforceAt.getTime() <= breach.getTime()
      ? `${subject} is enforceable immediately.`
      : `${subject} breached on ${utcDated(breach)} and becomes enforceable from ` +
        `${utcDated(enforceAt)}. All times UTC.`;

  return { window, deadline };
}

/* ------------------------------------------------------------ comment text -- */

/**
 * Fills the admin's template.
 *
 * `authorName` is substituted as plain text. The old app emitted a literal "@"
 * next to a real @mention, producing "@ @Ravi Acharya" in the audit trail, and
 * publicly @mentioning someone to announce their policy violation is a
 * questionable default besides. Plain text keeps the comment readable and
 * leaves the notification decision open.
 */
export function renderCommentTemplate(template, values) {
  const source = String(template ?? DEFAULT_COMMENT_TEMPLATE);
  return source
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (match, token) => {
      if (!COMMENT_TOKENS.includes(token)) return match;
      const value = values?.[token];
      return value === undefined || value === null || value === '' ? '' : String(value);
    })
    // Collapse whitespace left behind by empty tokens.
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Builds the comment as an ADF document, substituting `{{authorName}}` with a
 * real mention node so Jira notifies the author by email.
 *
 * A plain-text name does not notify anybody, which is the whole point of the
 * notification. The original app's defect was a literal "@" sitting next to the
 * mention — rendering "@ @Ravi Acharya" — not the mention itself, so the fix is
 * to emit exactly one proper mention node and no stray sigil.
 *
 * Falls back to plain text when there is no account id to mention.
 *
 * @param {string} template
 * @param {object} values                Token values.
 * @param {object} [mention]
 * @param {string} [mention.accountId]   Atlassian account id of the author.
 * @param {string} [mention.displayName] Name shown in the mention chip.
 */
export function buildCommentDocument(template, values, mention = {}) {
  const source = String(template ?? DEFAULT_COMMENT_TEMPLATE);
  const nodes = [];
  let buffer = '';

  const flush = () => {
    if (buffer) {
      nodes.push({ type: 'text', text: buffer });
      buffer = '';
    }
  };

  const pattern = /\{\{\s*(\w+)\s*\}\}/g;
  let cursor = 0;
  let match;

  while ((match = pattern.exec(source)) !== null) {
    buffer += source.slice(cursor, match.index);
    cursor = match.index + match[0].length;

    const token = match[1];
    if (!COMMENT_TOKENS.includes(token)) {
      buffer += match[0];
      continue;
    }

    if (token === 'authorName' && mention.accountId) {
      flush();
      nodes.push({
        type: 'mention',
        // `text` carries the leading @; Jira renders the chip from `id`.
        attrs: { id: mention.accountId, text: `@${mention.displayName ?? 'Unknown user'}` },
      });
      continue;
    }

    const value = values?.[token];
    buffer += value === undefined || value === null ? '' : String(value);
  }

  buffer += source.slice(cursor);
  flush();

  if (nodes.length === 0) nodes.push({ type: 'text', text: 'Worklog removed.' });

  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: nodes }] };
}

/**
 * Formats a timestamp the way Jira's worklog API demands it.
 *
 * The create-worklog endpoint rejects a bare "Z" suffix: it wants milliseconds
 * plus a numeric offset, e.g. 2026-06-01T09:00:00.000+0000. Getting this wrong
 * is a 400 with no useful detail.
 */
export function toJiraDateTime(value) {
  const date = parseDate(value);
  if (!date) return null;
  return date.toISOString().replace(/Z$/, "+0000");
}

/** Formats a worklog `started` value the way the console and comments show it. */
export function formatWorklogDate(value) {
  const date = parseDate(value);
  if (!date) return 'an unknown date';
  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/* ------------------------------------------------------------- log summary -- */

/**
 * Stats for the Removal Log cards, scoped to one calendar month.
 * Returns the scope label too, so the cards can say which month they mean.
 */
export function summariseRemovals(removalLog = [], now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  const inScope = removalLog.filter((entry) => {
    const at = parseDate(entry?.removedAt);
    return at && at.getUTCFullYear() === year && at.getUTCMonth() === month;
  });

  const byAuthor = new Map();
  for (const entry of inScope) {
    const name = entry.authorDisplayName || 'Unknown';
    byAuthor.set(name, (byAuthor.get(name) ?? 0) + 1);
  }

  let topAuthor = null;
  let topCount = 0;
  for (const [name, count] of byAuthor) {
    if (count > topCount) {
      topAuthor = name;
      topCount = count;
    }
  }

  return {
    removedThisMonth: inScope.length,
    issuesAffected: new Set(inScope.map((entry) => entry.issueKey)).size,
    topAuthor,
    topAuthorCount: topCount,
    scopeLabel: new Date(Date.UTC(year, month, 1)).toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }),
  };
}
