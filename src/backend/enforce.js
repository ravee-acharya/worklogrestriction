import {
  ACTION,
  PERIOD,
  STATE,
  classifyWorklogs,
  buildCommentDocument,
  formatWorklogDate,
  validateConfig,
} from '../shared/rules.mjs';
import { appendPendingReview, appendRemovalLog } from './store.js';
import {
  deleteWorklog,
  fetchIssueContext,
  fetchStatusChangelog,
  fetchWorklogs,
  postComment,
} from './jira.js';

/**
 * The one enforcement path, shared by the issue panel resolver and the worklog
 * trigger, so the two surfaces can never disagree about what counts as a
 * violation or when it gets acted on.
 */

/** Fail-safe project gate. Anything unknown means "not enabled". */
export function isProjectEnabled(config, projectKey) {
  if (!projectKey) return false;
  return config.enabledProjects.includes(projectKey);
}

/**
 * Evaluates every worklog on an issue and applies the configured action to the
 * ones whose grace period has expired.
 *
 * @param {object}  args
 * @param {string}  args.issueIdOrKey
 * @param {object}  args.config           Normalised config.
 * @param {Date}    [args.now]
 * @param {boolean} [args.dryRun]         Classify only; never mutate Jira.
 * @param {string[]|null} [args.enforceOnlyWorklogIds]
 *        When set, only these worklog ids may be enforced; everything else is
 *        classified for display only. The worklog-created trigger passes the
 *        single worklog from its event, so logging one entry cannot cascade
 *        into deleting an issue's whole history.
 * @returns {Promise<object>} panel-ready result
 */
export async function evaluateIssue({
  issueIdOrKey,
  config,
  now = new Date(),
  dryRun = false,
  enforceOnlyWorklogIds = null,
}) {
  // An incomplete rule must never enforce. "After Status Transition" with no
  // target status used to save cleanly and sit there looking armed.
  if (!validateConfig(config).ok) {
    return { active: false, reason: 'invalid-config', issue: null, results: [], enforced: [] };
  }

  const issue = await fetchIssueContext(issueIdOrKey);

  if (!isProjectEnabled(config, issue.projectKey)) {
    return { active: false, reason: 'project-disabled', issue, results: [], enforced: [] };
  }

  const [worklogs, changelog] = await Promise.all([
    fetchWorklogs(issue.key),
    config.period === PERIOD.AFTER_TRANSITION
      ? fetchStatusChangelog(issue.key)
      : Promise.resolve([]),
  ]);

  // No stored state needed: the grace deadline is derived from the worklog and
  // the rule, so every evaluation reaches the same verdict.
  const { results } = classifyWorklogs({ worklogs, config, changelog, now });

  if (dryRun) {
    return { active: true, issue, results, enforced: [] };
  }

  const allowed = enforceOnlyWorklogIds ? new Set(enforceOnlyWorklogIds.map(String)) : null;
  const due = results.filter(
    (result) =>
      result.state === STATE.ENFORCE && (!allowed || allowed.has(String(result.worklog.id))),
  );
  if (due.length === 0) {
    return { active: true, issue, results, enforced: [] };
  }

  const enforced =
    config.action === ACTION.DELETE
      ? await enforceByDeleting({ due, issue, config, now })
      : await enforceByFlagging({ due, issue, config, now });

  return { active: true, issue, results, enforced };
}

/**
 * Hard ceiling on deletions per invocation.
 *
 * Forge kills a function at 25 seconds. A delete plus a comment is two API
 * calls, and Jira rate-limits under load, so a large batch reliably times out
 * mid-loop. Capping it keeps every invocation short enough to finish; whatever
 * is left over is picked up by the next evaluation of the same issue.
 */
const MAX_ENFORCEMENTS_PER_INVOCATION = 10;

async function enforceByDeleting({ due, issue, config, now }) {
  const enforced = [];

  const batch = due.slice(0, MAX_ENFORCEMENTS_PER_INVOCATION);
  if (due.length > batch.length) {
    console.log(
      `Deferring ${due.length - batch.length} deletion(s) on ${issue.key} to the next run ` +
        `to stay inside the function time limit.`,
    );
  }

  for (const result of batch) {
    const worklog = result.worklog;
    try {
      const outcome = await deleteWorklog(issue.key, worklog.id);

      // Only narrate a deletion this run actually performed.
      if (outcome.deleted) {
        const document = buildCommentDocument(
          config.commentTemplate,
          {
            authorName: worklog.authorDisplayName ?? 'Unknown user',
            worklogDate: formatWorklogDate(worklog.started),
            issueKey: issue.key,
            issueSummary: issue.summary,
            restrictionRule: result.rule ?? '',
            projectName: issue.projectName,
          },
          // The mention is what makes Jira email the author.
          { accountId: worklog.authorAccountId, displayName: worklog.authorDisplayName },
        );


        // Written per deletion, immediately. Batching this until the end of the
        // loop meant a mid-loop timeout destroyed the audit record for every
        // deletion the invocation had already performed — the worklogs were
        // gone with nothing to say what they were.
        await appendRemovalLog([{
          id: `${issue.key}:${worklog.id}`,
          issueKey: issue.key,
          issueSummary: issue.summary,
          projectKey: issue.projectKey,
          worklogId: worklog.id,
          // Captured explicitly — the old log left every author blank, which
          // also made the "Top author" stat permanently empty.
          authorAccountId: worklog.authorAccountId,
          authorDisplayName: worklog.authorDisplayName ?? 'Unknown user',
          worklogStarted: worklog.started,
          timeSpent: worklog.timeSpent,
          timeSpentSeconds: worklog.timeSpentSeconds,
          ruleViolated: result.rule,
          violationSince: result.violationSince,
          removedAt: new Date().toISOString(),
        }]);

        // Only now that the deletion is durably recorded. A failed comment
        // must not orphan the audit entry.
        try {
          await postComment(issue.key, document);
        } catch (error) {
          console.error(`Deleted worklog ${worklog.id} but could not comment: ${error.message}`);
        }

        enforced.push({ worklogId: worklog.id, action: 'deleted' });
      } else {
        enforced.push({ worklogId: worklog.id, action: 'already-gone' });
      }

    } catch (error) {
      // Nothing to unwind: the next evaluation recomputes the same verdict and
      // retries this worklog.
      console.error(`Enforcement failed for worklog ${worklog.id}: ${error.message}`);
      enforced.push({ worklogId: worklog.id, action: 'failed', message: error.message });
    }
  }

  return enforced;
}

async function enforceByFlagging({ due, issue, config, now }) {
  // Capped like the delete path: this now makes an API call per entry, so an
  // unbounded batch could hit the function time limit.
  const batch = due.slice(0, MAX_ENFORCEMENTS_PER_INVOCATION);
  if (due.length > batch.length) {
    console.log(
      `Deferring ${due.length - batch.length} flag(s) on ${issue.key} to the next run.`,
    );
  }

  const entries = batch.map((result) => ({
    id: `${issue.key}:${result.worklog.id}`,
    issueKey: issue.key,
    issueSummary: issue.summary,
    projectKey: issue.projectKey,
    worklogId: result.worklog.id,
    authorAccountId: result.worklog.authorAccountId,
    authorDisplayName: result.worklog.authorDisplayName ?? 'Unknown user',
    worklogStarted: result.worklog.started,
    timeSpent: result.worklog.timeSpent,
    timeSpentSeconds: result.worklog.timeSpentSeconds,
    ruleViolated: result.rule,
    violationSince: result.violationSince,
    flaggedAt: now.toISOString(),
  }));

  // Queue first, notify second: the review queue is the durable record, and a
  // comment failure must not cost us the entry.
  await appendPendingReview(entries);

  if (config.commentOnFlag) {
    for (const entry of entries) {
      const document = buildCommentDocument(
        config.flagCommentTemplate,
        {
          authorName: entry.authorDisplayName,
          worklogDate: formatWorklogDate(entry.worklogStarted),
          issueKey: issue.key,
          issueSummary: issue.summary,
          restrictionRule: entry.ruleViolated ?? '',
          projectName: issue.projectName,
        },
        { accountId: entry.authorAccountId, displayName: entry.authorDisplayName },
      );

      try {
        await postComment(issue.key, document);
      } catch (error) {
        console.error(`Flagged worklog ${entry.worklogId} but could not comment: ${error.message}`);
      }
    }
  }

  return entries.map((entry) => ({ worklogId: entry.worklogId, action: 'flagged' }));
}

/** Trims an evaluation result down to what the issue panel renders. */
export function toPanelPayload(result, config) {
  if (!result.active) {
    return { active: false, checked: 0, worklogs: [] };
  }

  return {
    active: true,
    action: config.action,
    checked: result.results.length,
    enforced: result.enforced,
    worklogs: result.results.map((entry) => ({
      id: entry.worklog.id,
      started: entry.worklog.started,
      timeSpent: entry.worklog.timeSpent,
      authorDisplayName: entry.worklog.authorDisplayName ?? 'Unknown user',
      state: entry.state,
      rule: entry.rule,
      enforceAt: entry.enforceAt,
      violationSince: entry.violationSince ?? null,
      detail: entry.detail ?? {},
    })),
  };
}
