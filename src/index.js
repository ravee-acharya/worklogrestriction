import Resolver from '@forge/resolver';
import { normaliseConfig, toJiraDateTime, validateConfig } from './shared/rules.mjs';
import { evaluateIssue, toPanelPayload } from './backend/enforce.js';
import {
  fetchProjects,
  fetchStatuses,
  isJiraAdmin,
  restoreWorklog,
} from './backend/jira.js';
import {
  markRestoredOne,
  readConfig,
  readPendingReview,
  readRemovalLog,
  removePendingReview,
  removePendingReviewMany,
  writeConfig,
} from './backend/store.js';

const resolver = new Resolver();

/** Restores attempted per resolver call. Kept well inside the 25s function cap. */
const MAX_RESTORE_BATCH = 15;

/**
 * Every admin-console resolver runs behind this. The console also hides itself
 * from non-admins, but that is presentation only — resolvers are directly
 * invokable, so authorisation has to happen here.
 */
function adminOnly(handler) {
  return async (request) => {
    const accountId = request?.context?.accountId;
    if (!(await isJiraAdmin(accountId))) {
      throw new Error('Jira Administrator rights are required.');
    }
    return handler(request);
  };
}

/* ------------------------------------------------------------ admin console -- */

resolver.define('bootstrap', async (request) => {
  const accountId = request?.context?.accountId;
  const isAdmin = await isJiraAdmin(accountId);
  if (!isAdmin) return { isAdmin: false, config: null };
  return { isAdmin: true, config: await readConfig() };
});

resolver.define(
  'getStatuses',
  adminOnly(async () => fetchStatuses()),
);

resolver.define(
  'getProjects',
  adminOnly(async () => {
    const [projects, config] = await Promise.all([fetchProjects(), readConfig()]);
    const enabled = new Set(config.enabledProjects);
    return projects.map((project) => ({ ...project, isEnabled: enabled.has(project.key) }));
  }),
);

resolver.define(
  'saveConfig',
  adminOnly(async ({ payload }) => {
    const incoming = normaliseConfig(payload?.config);
    const stored = await readConfig();

    // The project selection is owned by the Projects tab; the rules form must
    // not be able to clobber it just because it holds a stale copy.
    const merged = { ...incoming, enabledProjects: stored.enabledProjects };

    // Stamp the activation time so the rule applies going forward only.
    // Anything already logged stays exempt: a policy switched on today must not
    // reach back and delete history recorded when no policy existed. Re-stamped
    // whenever the rule itself changes, which always errs toward enforcing less.
    const ruleChanged =
      stored.period !== merged.period ||
      stored.targetStatusName !== merged.targetStatusName ||
      stored.transitionGraceHours !== merged.transitionGraceHours ||
      stored.resetOnReopen !== merged.resetOnReopen ||
      stored.enforcementGraceHours !== merged.enforcementGraceHours ||
      stored.enforcementGraceWorkingDays !== merged.enforcementGraceWorkingDays;

    merged.effectiveFrom =
      stored.effectiveFrom && !ruleChanged ? stored.effectiveFrom : new Date().toISOString();

    const validation = validateConfig(merged);
    if (!validation.ok) {
      throw new Error(Object.values(validation.errors).join(' '));
    }

    // Returns what was actually written, so the console can re-seed its state
    // from server truth instead of assuming the write matched the draft.
    return writeConfig(merged);
  }),
);

resolver.define(
  'saveProjects',
  adminOnly(async ({ payload }) => {
    const keys = Array.isArray(payload?.enabledProjects) ? payload.enabledProjects : [];
    const stored = await readConfig();
    return writeConfig({ ...stored, enabledProjects: keys });
  }),
);

resolver.define(
  'getLog',
  adminOnly(async () => {
    const [log, pendingReview] = await Promise.all([readRemovalLog(), readPendingReview()]);
    return { removalLog: log.entries, dropped: log.dropped, pendingReview };
  }),
);

/**
 * Re-creates worklogs this app deleted.
 *
 * Deliberately not a blanket "undo everything": pass entryIds to repair a
 * specific set, or use limit to walk the backlog in batches. Entries already
 * marked restored are skipped, so re-running cannot double-post.
 */
resolver.define(
  'restoreRemovals',
  adminOnly(async ({ payload }) => {
    const requested = Array.isArray(payload?.entryIds) ? payload.entryIds.map(String) : null;
    // Each restore is one POST, and Forge kills the function at 25 seconds.
    // The console walks larger selections in chunks rather than asking for a
    // batch that cannot finish.
    const limit = Number.isFinite(Number(payload?.limit)) ? Number(payload.limit) : MAX_RESTORE_BATCH;
    const allowAppFallback = payload?.allowAppFallback === true;

    const { entries } = await readRemovalLog();
    const candidates = entries
      .filter((entry) => !entry.restoredAt)
      .filter((entry) => (requested ? requested.includes(entry.id) : true))
      .slice(0, Math.max(1, Math.min(limit, MAX_RESTORE_BATCH)));

    let restored = 0;
    const report = [];

    for (const entry of candidates) {
      const startedIso = toJiraDateTime(entry.worklogStarted);
      if (!startedIso || !entry.timeSpentSeconds) {
        report.push({
          id: entry.id,
          ok: false,
          error: 'Entry is missing a usable date or duration.',
        });
        continue;
      }

      const result = await restoreWorklog({
        issueKey: entry.issueKey,
        startedIso,
        timeSpentSeconds: entry.timeSpentSeconds,
        accountId: entry.authorAccountId,
        allowAppFallback,
      });

      // Marked immediately, not accumulated. If this invocation is killed
      // part-way, everything already put back stays marked, so a re-run cannot
      // post a second copy of the same worklog.
      if (result.ok) {
        await markRestoredOne(entry.id, new Date().toISOString());
        restored += 1;
      }

      report.push({
        id: entry.id,
        issueKey: entry.issueKey,
        ok: result.ok,
        // Verified against the created worklog, not assumed from the request.
        attributedToOriginalAuthor:
          result.ok && result.authorAccountId === entry.authorAccountId,
        recordedAuthorAccountId: result.authorAccountId ?? null,
        expectedAuthorAccountId: entry.authorAccountId ?? null,
        error: result.error ?? null,
      });
    }

    // Restored worklogs are backdated by definition, so without this they would
    // immediately re-register as fresh violations. Moving the activation stamp
    // past the restore grandfathers everything just put back.
    if (restored > 0) {
      const stored = await readConfig();
      await writeConfig({ ...stored, effectiveFrom: new Date().toISOString() });
    }

    const { entries: after } = await readRemovalLog();
    const outstanding = after.filter((entry) => !entry.restoredAt);
    return {
      report,
      restored,
      remaining: outstanding.length,
      // Lets the console keep going without re-deriving the queue itself.
      nextEntryIds: outstanding.slice(0, MAX_RESTORE_BATCH).map((entry) => entry.id),
    };
  }),
);

/**
 * Marks deletions as already put right by hand, without touching Jira.
 *
 * Needed because worklogs restored manually are invisible to this app: nothing
 * sets restoredAt except its own restore path, so those entries still look
 * outstanding and a bulk restore would post a second copy of each one.
 */
resolver.define(
  'markExternallyRestored',
  adminOnly(async ({ payload }) => {
    const ids = Array.isArray(payload?.entryIds) ? payload.entryIds.map(String) : [];
    if (ids.length === 0) throw new Error('No entries selected.');

    const at = new Date().toISOString();
    for (const id of ids) {
      await markRestoredOne(id, at);
    }

    const { entries } = await readRemovalLog();
    return { marked: ids.length, remaining: entries.filter((e) => !e.restoredAt).length };
  }),
);

resolver.define(
  'markReviewed',
  adminOnly(async ({ payload }) => {
    const entryId = String(payload?.entryId ?? '');
    if (!entryId) throw new Error('Missing entry id.');
    return { pendingReview: await removePendingReview(entryId) };
  }),
);

/**
 * Clears a set of flagged worklogs from the review queue.
 *
 * No Jira calls and no batching: the queue lives entirely in one KVS value, so
 * the whole selection clears in a single write. Reports how many rows actually
 * disappeared rather than how many were asked for, so a stale console selection
 * cannot report work that did not happen.
 */
resolver.define(
  'markReviewedBulk',
  adminOnly(async ({ payload }) => {
    const ids = Array.isArray(payload?.entryIds) ? payload.entryIds.map(String) : [];
    if (ids.length === 0) throw new Error('No entries selected.');

    const before = (await readPendingReview()).length;
    const pendingReview = await removePendingReviewMany(ids);
    return { reviewed: before - pendingReview.length, pendingReview };
  }),
);

/* --------------------------------------------------------------- issue panel -- */

/**
 * Validates (and enforces on) the issue the panel is open on.
 *
 * Deliberately not admin-gated: the panel is a compliance display for whoever
 * is looking at the issue. Enforcement runs as the app either way, and the
 * project gate plus config validation decide whether anything happens at all.
 */
resolver.define('validateIssue', async (request) => {
  const issueKey = request?.context?.extension?.issue?.key;
  const issueId = request?.context?.extension?.issue?.id;
  const target = issueKey ?? issueId;

  if (!target) {
    throw new Error('Could not determine which issue this panel is on.');
  }

  const config = await readConfig();
  const result = await evaluateIssue({ issueIdOrKey: target, config });
  return toPanelPayload(result, config);
});

export const handler = resolver.getDefinitions();

/* ------------------------------------------------------------------ trigger -- */

/**
 * Headless enforcement when a worklog is created.
 *
 * A standalone exported function, not a resolver — product events never invoke
 * resolvers. Registered under `modules.trigger` in the manifest.
 *
 * The payload carries only `{ eventType, selfGenerated, worklog }`: no issue
 * key, no project. `evaluateIssue` resolves the issue from `worklog.issueId`
 * and applies the project gate from there.
 *
 * Errors are logged and swallowed. A thrown error would be retried by the
 * platform, and retrying a partially-applied deletion is worse than dropping it
 * — the panel and the next worklog event both re-check the issue anyway.
 */
export async function onWorklogCreated(event) {
  try {
    const issueId = event?.worklog?.issueId;
    if (!issueId) {
      console.warn('worklog event had no issueId; payload keys: ' + Object.keys(event ?? {}).join(','));
      return;
    }

    const config = await readConfig();
    const result = await evaluateIssue({
      issueIdOrKey: String(issueId),
      config,
      // Only the worklog this event is about. Evaluating the issue is fine —
      // enforcing across it is not, and previously one new entry could delete
      // every historical violation sharing the issue.
      enforceOnlyWorklogIds: event?.worklog?.id ? [String(event.worklog.id)] : [],
    });

    if (!result.active) {
      console.log(`No enforcement for issue ${issueId}: ${result.reason}`);
      return;
    }

    if (result.enforced.length > 0) {
      console.log(
        `Enforced on ${result.issue.key}: ${result.enforced
          .map((entry) => `${entry.worklogId}=${entry.action}`)
          .join(', ')}`,
      );
    }
  } catch (error) {
    console.error(`Worklog trigger failed: ${error?.message}`, error?.stack);
  }
}
