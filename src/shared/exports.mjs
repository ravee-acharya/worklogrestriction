// Column definitions and row shaping for the Excel exports.
//
// Kept pure and separate from the workbook writer so what goes into the file is
// testable without parsing a ZIP, and so the admin console does not grow
// another copy of the field mapping.

const SECONDS_PER_HOUR = 3600;

/** Hours to two decimals, so a column of them sums cleanly in Excel. */
function toHours(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round((value / SECONDS_PER_HOUR) * 100) / 100;
}

/**
 * Both exports carry the account id as well as the display name.
 *
 * Display names are not unique and change when people are renamed; the account
 * id is what anyone reconciling an export against Jira actually needs.
 */
const SHARED_COLUMNS = [
  { key: 'issueKey', label: 'Issue key', type: 'text', width: 14 },
  { key: 'issueSummary', label: 'Issue summary', type: 'text', width: 44 },
  { key: 'projectKey', label: 'Project', type: 'text', width: 12 },
  { key: 'authorDisplayName', label: 'Author', type: 'text', width: 24 },
  { key: 'authorAccountId', label: 'Author account ID', type: 'text', width: 30 },
  { key: 'worklogStarted', label: 'Worklog date (UTC)', type: 'date', width: 18 },
  { key: 'timeSpent', label: 'Time spent', type: 'text', width: 13 },
  { key: 'hours', label: 'Hours', type: 'number', width: 9 },
  { key: 'ruleViolated', label: 'Rule violated', type: 'text', width: 22 },
  { key: 'violationSince', label: 'Breached at (UTC)', type: 'datetime', width: 20 },
  { key: 'worklogId', label: 'Worklog ID', type: 'text', width: 14 },
];

export const REMOVAL_LOG_COLUMNS = [
  { key: 'removedAt', label: 'Removed at (UTC)', type: 'datetime', width: 20 },
  ...SHARED_COLUMNS,
  { key: 'restored', label: 'Restored', type: 'text', width: 10 },
  { key: 'restoredAt', label: 'Restored at (UTC)', type: 'datetime', width: 20 },
];

export const PENDING_REVIEW_COLUMNS = [
  { key: 'flaggedAt', label: 'Flagged at (UTC)', type: 'datetime', width: 20 },
  ...SHARED_COLUMNS,
];

function sharedRow(entry) {
  return {
    issueKey: entry.issueKey ?? '',
    issueSummary: entry.issueSummary ?? '',
    projectKey: entry.projectKey ?? '',
    authorDisplayName: entry.authorDisplayName || 'Unknown',
    authorAccountId: entry.authorAccountId ?? '',
    worklogStarted: entry.worklogStarted ?? '',
    timeSpent: entry.timeSpent ?? '',
    hours: toHours(entry.timeSpentSeconds),
    ruleViolated: entry.ruleViolated ?? '',
    violationSince: entry.violationSince ?? '',
    worklogId: entry.worklogId === undefined || entry.worklogId === null ? '' : String(entry.worklogId),
  };
}

export function removalLogRows(entries = []) {
  return entries.map((entry) => ({
    removedAt: entry.removedAt ?? '',
    ...sharedRow(entry),
    restored: entry.restoredAt ? 'Yes' : 'No',
    restoredAt: entry.restoredAt ?? '',
  }));
}

export function pendingReviewRows(entries = []) {
  return entries.map((entry) => ({
    flaggedAt: entry.flaggedAt ?? '',
    ...sharedRow(entry),
  }));
}

/**
 * `worklog-removal-log-2026-09-15.xlsx`, or with an active filter,
 * `worklog-removal-log-2026-08-sagar-2026-09-15.xlsx`.
 *
 * The filter goes in the name because these files get mailed around, and a
 * filtered export that looks like a full one is how someone concludes only
 * eight worklogs were removed.
 */
export function exportFileName(prefix, now = new Date(), suffix = '') {
  const date = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  return `${prefix}${suffix}-${date.toISOString().slice(0, 10)}.xlsx`;
}
