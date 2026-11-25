import { invoke } from '@forge/bridge';
import {
  ACTION,
  ACTION_LABELS,
  COMMENT_TEMPLATE_MAX,
  COMMENT_TOKENS,
  DEFAULT_COMMENT_TEMPLATE,
  DEFAULT_FLAG_COMMENT_TEMPLATE,
  PERIOD,
  PERIOD_LABELS,
  describeGrace,
  describePeriod,
  graceFromToken,
  graceOptions,
  graceToken,
  TRANSITION_GRACE_OPTIONS,
  normaliseConfig,
  renderCommentTemplate,
  summariseRemovals,
  validateConfig,
} from '../../shared/rules.mjs';
import { buildWorkbook } from '../../shared/xlsx.mjs';
import {
  PENDING_REVIEW_COLUMNS,
  REMOVAL_LOG_COLUMNS,
  exportFileName,
  pendingReviewRows,
  removalLogRows,
} from '../../shared/exports.mjs';
import {
  applyFilters,
  authorOptions,
  describeFilters,
  filterFileSuffix,
  hasActiveFilters,
  monthOptions,
} from '../../shared/filters.mjs';
import {
  badge,
  clear,
  confirmBar,
  el,
  fieldError,
  projectAvatar,
  select,
  spinner,
  toggle,
} from '../dom.js';

const PAGE_SIZE = 50;
/** Log tables page smaller: rows are denser and there can be thousands. */
const LOG_PAGE_SIZE = 25;

const TABS = [
  { id: 'rules', label: 'Restriction Rules' },
  { id: 'projects', label: 'Projects' },
  { id: 'preview', label: 'Validator Preview' },
  { id: 'log', label: 'Removal Log' },
];

/** Example values behind the comment-template live preview. */
const PREVIEW_VALUES = {
  authorName: 'Rahul Mehta',
  worklogDate: 'July 1, 2026',
  issueKey: 'ABC-123',
  issueSummary: 'Reconcile Q2 timesheets',
  restrictionRule: 'Last 1 Week',
  projectName: 'Example Project',
};

const state = {
  phase: 'loading', // loading | denied | ready | error
  error: null,

  /** Last known server truth. Re-read after every successful save. */
  config: null,
  /** Working copy for the Restriction Rules form. */
  draft: null,
  ruleErrors: {},
  savingRules: false,
  rulesMessage: null,

  statuses: { phase: 'idle', items: [], error: null },

  projects: { phase: 'idle', items: [], error: null },
  /** Project key -> boolean, only while unsaved. */
  projectEdits: {},
  projectQuery: '',
  projectPage: 1,
  savingProjects: false,
  projectsMessage: null,
  pendingBulk: null,

  log: { phase: 'idle', removalLog: [], pendingReview: [], error: null },
  reviewingId: null,
  /** Entry id currently being restored, and the last restore outcome. */
  restoringId: null,
  restoreReport: null,
  /** Selected removal-log entry ids, for selective restore. */
  selectedEntryIds: new Set(),
  /** Non-null while a bulk restore is walking its batches. */
  bulkRestore: null,
  pendingBulkRestore: null,
  /** Collapsed state, page and sort direction for each log table. */
  logCollapsed: { removals: false, pending: false },
  logPage: { removals: 1, pending: 1 },
  logSort: { removals: 'desc', pending: 'desc' },
  /** Month + author filters, held separately per table. */
  logFilters: {
    removals: { month: '', author: '' },
    pending: { month: '', author: '' },
  },
  /** Selected pending-review entry ids, for bulk review. */
  selectedPendingIds: new Set(),
  /** Set while a bulk review is in flight, and while its confirm is showing. */
  bulkReviewing: false,
  pendingBulkReview: null,
  reviewReport: null,
  /** Surfaced when a download could not be produced or handed to the browser. */
  exportError: null,

  tab: 'rules',
  tabWarning: null,
};

const root = document.getElementById('root');

/* ------------------------------------------------------------------ helpers -- */

const configsEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function rulesDirty() {
  if (!state.config || !state.draft) return false;
  const { enabledProjects: _a, ...draft } = state.draft;
  const { enabledProjects: _b, ...saved } = state.config;
  return !configsEqual(draft, saved);
}

function projectsDirty() {
  return Object.keys(state.projectEdits).length > 0;
}

/** Effective enabled/disabled for a project, unsaved edits taking precedence. */
function projectEnabled(project) {
  return state.projectEdits[project.key] ?? project.isEnabled;
}

function filteredProjects() {
  const query = state.projectQuery.trim().toLowerCase();
  if (!query) return state.projects.items;
  return state.projects.items.filter(
    (project) =>
      project.name.toLowerCase().includes(query) || project.key.toLowerCase().includes(query),
  );
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/* -------------------------------------------------------------------- boot -- */

async function boot() {
  try {
    const result = await invoke('bootstrap');
    if (!result.isAdmin) {
      state.phase = 'denied';
      render();
      return;
    }
    state.config = normaliseConfig(result.config);
    state.draft = { ...state.config };
    state.phase = 'ready';
    render();
    if (state.draft.period === PERIOD.AFTER_TRANSITION) loadStatuses();
  } catch (error) {
    state.phase = 'error';
    state.error = error?.message ?? 'Could not load the app configuration.';
    render();
  }
}

async function loadStatuses() {
  if (state.statuses.phase === 'loading' || state.statuses.phase === 'ready') return;
  state.statuses = { phase: 'loading', items: [], error: null };
  render();
  try {
    const items = await invoke('getStatuses');
    state.statuses = { phase: 'ready', items, error: null };
  } catch (error) {
    state.statuses = {
      phase: 'error',
      items: [],
      error: error?.message ?? 'Could not load statuses — please retry.',
    };
  }
  render();
}

async function loadProjects() {
  if (state.projects.phase === 'loading' || state.projects.phase === 'ready') return;
  state.projects = { phase: 'loading', items: [], error: null };
  render();
  try {
    const items = await invoke('getProjects');
    state.projects = { phase: 'ready', items, error: null };
  } catch (error) {
    state.projects = {
      phase: 'error',
      items: [],
      error: error?.message ?? 'Could not load projects.',
    };
  }
  render();
}

async function loadLog() {
  if (state.log.phase === 'loading' || state.log.phase === 'ready') return;
  state.log = { phase: 'loading', removalLog: [], pendingReview: [], error: null };
  render();
  try {
    const result = await invoke('getLog');
    state.log = {
      phase: 'ready',
      removalLog: result.removalLog ?? [],
      pendingReview: result.pendingReview ?? [],
      error: null,
    };
  } catch (error) {
    state.log = {
      phase: 'error',
      removalLog: [],
      pendingReview: [],
      error: error?.message ?? 'Could not load the removal log.',
    };
  }
  render();
}

/* ------------------------------------------------------------------ actions -- */

async function saveRules() {
  const validation = validateConfig(state.draft);
  state.ruleErrors = validation.errors;
  state.rulesMessage = null;

  if (!validation.ok) {
    render();
    return;
  }

  state.savingRules = true;
  render();

  try {
    // The resolver returns the stored object it just wrote, so the console shows
    // server truth rather than assuming the write matched the draft. Skipping
    // this is what left Validator Preview reporting a stale period after a save.
    const saved = await invoke('saveConfig', { config: state.draft });
    state.config = normaliseConfig(saved);
    state.draft = { ...state.config };
    state.rulesMessage = { tone: 'ok', text: 'Configuration saved successfully.' };
  } catch (error) {
    state.rulesMessage = {
      tone: 'err',
      text: error?.message ?? 'Could not save the configuration. Nothing was changed.',
    };
  } finally {
    state.savingRules = false;
    render();
  }
}

async function saveProjects() {
  const enabled = new Set(state.config.enabledProjects);
  for (const [key, isOn] of Object.entries(state.projectEdits)) {
    if (isOn) enabled.add(key);
    else enabled.delete(key);
  }

  state.savingProjects = true;
  state.projectsMessage = null;
  render();

  try {
    const saved = await invoke('saveProjects', { enabledProjects: [...enabled] });
    state.config = normaliseConfig(saved);
    // Reaching this tab discards any unsaved rule edits, so the draft can be
    // re-seeded from server truth unconditionally.
    state.draft = { ...state.config };
    state.projectEdits = {};
    state.projects.items = state.projects.items.map((project) => ({
      ...project,
      isEnabled: state.config.enabledProjects.includes(project.key),
    }));
    state.projectsMessage = { tone: 'ok', text: 'Projects saved successfully.' };
  } catch (error) {
    state.projectsMessage = {
      tone: 'err',
      text: error?.message ?? 'Could not save the project selection. Nothing was changed.',
    };
  } finally {
    state.savingProjects = false;
    render();
  }
}

/**
 * Applies a bulk toggle to the rows currently on screen.
 *
 * The old buttons ignored the search box: filtering to one project and pressing
 * "Disable all" rewrote all 243. Enabling in bulk arms automatic deletion, so
 * that direction also asks first.
 */
function applyBulk(enable) {
  const targets = filteredProjects();
  for (const project of targets) {
    if (project.isEnabled === enable) delete state.projectEdits[project.key];
    else state.projectEdits[project.key] = enable;
  }
  state.pendingBulk = null;
  state.projectsMessage = null;
  render();
}

function requestBulk(enable) {
  const targets = filteredProjects();
  if (targets.length === 0) return;

  // Disabling only ever reduces enforcement, so it applies straight away.
  if (!enable) {
    applyBulk(false);
    return;
  }

  state.pendingBulk = { enable, count: targets.length, scoped: state.projectQuery.trim() !== '' };
  render();
}

/**
 * Puts a single deleted worklog back.
 *
 * One entry at a time on purpose. Attribution depends on impersonation being
 * permitted for that author, which cannot be known until it is attempted, so
 * the outcome is reported per entry rather than assumed for a whole batch.
 */
async function restoreOne(entryId) {
  state.restoringId = entryId;
  state.restoreReport = null;
  render();

  try {
    const result = await invoke('restoreRemovals', { entryIds: [entryId], limit: 1 });
    const outcome = result.report?.[0] ?? null;
    state.restoreReport = outcome
      ? { ...outcome, remaining: result.remaining }
      : { ok: false, error: 'The restore returned no result for that entry.' };

    // Re-read the log so the row reflects what the server actually stored.
    state.restoringId = null;
    state.log = { phase: 'idle', removalLog: [], pendingReview: [], error: null };
    await loadLog();
    return;
  } catch (error) {
    state.restoreReport = { ok: false, error: error?.message ?? 'The restore failed.' };
  } finally {
    state.restoringId = null;
    render();
  }
}

/**
 * Restores a set of entries, in server-capped batches.
 *
 * The resolver deliberately refuses more than a handful per call, because a
 * long loop of Jira writes gets killed at the 25 second function limit. So the
 * console drives the batching and reports progress as it goes, rather than
 * firing one request that silently dies half-done.
 */
async function restoreMany(entryIds, label) {
  const queue = [...entryIds];
  const totals = { attempted: 0, restored: 0, misattributed: 0, failed: 0, errors: [] };
  state.pendingBulkRestore = null;
  state.bulkRestore = { label, total: queue.length, done: 0 };
  state.restoreReport = null;
  render();

  while (queue.length > 0) {
    const chunk = queue.splice(0, 15);
    try {
      const result = await invoke('restoreRemovals', { entryIds: chunk, limit: chunk.length });
      for (const row of result.report ?? []) {
        totals.attempted += 1;
        if (!row.ok) {
          totals.failed += 1;
          if (row.error && totals.errors.length < 3) totals.errors.push(row.error);
        } else if (row.attributedToOriginalAuthor) {
          totals.restored += 1;
        } else {
          totals.misattributed += 1;
        }
      }
    } catch (error) {
      totals.failed += chunk.length;
      if (totals.errors.length < 3) totals.errors.push(error?.message ?? 'Batch failed.');
      // A whole batch failing usually means the run cannot continue at all.
      break;
    }

    state.bulkRestore.done = totals.attempted;
    render();
  }

  state.bulkRestore = null;
  state.selectedEntryIds = new Set();
  state.restoreReport = { bulk: true, ...totals };
  state.log = { phase: 'idle', removalLog: [], pendingReview: [], error: null };
  await loadLog();
}

/**
 * Records that these deletions were already fixed outside the app.
 *
 * Writes nothing to Jira. Purely bookkeeping, so bulk restore stops offering to
 * re-create worklogs that a human already re-entered by hand.
 */
async function markSelectedExternallyRestored(entryIds) {
  state.bulkRestore = { label: 'marking as already restored', total: entryIds.length, done: 0 };
  state.restoreReport = null;
  render();

  try {
    const result = await invoke('markExternallyRestored', { entryIds });
    state.restoreReport = {
      bulk: true,
      attempted: result.marked,
      restored: 0,
      misattributed: 0,
      failed: 0,
      errors: [],
      markedOnly: result.marked,
    };
    state.selectedEntryIds = new Set();
  } catch (error) {
    state.restoreReport = { ok: false, error: error?.message ?? 'Could not mark those entries.' };
  } finally {
    state.bulkRestore = null;
    state.log = { phase: 'idle', removalLog: [], pendingReview: [], error: null };
    await loadLog();
  }
}

function toggleSelected(entryId, on) {
  if (on) state.selectedEntryIds.add(entryId);
  else state.selectedEntryIds.delete(entryId);
  render();
}

function selectAllVisible(entries, on) {
  for (const entry of entries) {
    if (entry.restoredAt) continue;
    if (on) state.selectedEntryIds.add(entry.id);
    else state.selectedEntryIds.delete(entry.id);
  }
  render();
}

async function markReviewed(entryId) {
  state.reviewingId = entryId;
  state.reviewReport = null;
  render();
  try {
    const result = await invoke('markReviewed', { entryId });
    state.log.pendingReview = result.pendingReview ?? [];
    state.selectedPendingIds.delete(entryId);
  } catch (error) {
    state.log.error = error?.message ?? 'Could not mark that entry reviewed.';
  } finally {
    state.reviewingId = null;
    render();
  }
}

/* --------------------------------------------------------------- bulk review -- */

function togglePendingSelected(entryId, on) {
  if (on) state.selectedPendingIds.add(entryId);
  else state.selectedPendingIds.delete(entryId);
  render();
}

function selectAllPendingVisible(entries, on) {
  for (const entry of entries) {
    if (on) state.selectedPendingIds.add(entry.id);
    else state.selectedPendingIds.delete(entry.id);
  }
  render();
}

/**
 * Clears a set of flagged worklogs from the queue in one call.
 *
 * Unlike a bulk restore there is no batching here: reviewing writes to KVS and
 * never to Jira, so the whole selection clears in a single resolver call with
 * nothing to time out half-way.
 */
async function markReviewedBulk(entryIds) {
  state.bulkReviewing = true;
  state.pendingBulkReview = null;
  state.reviewReport = null;
  render();

  try {
    const result = await invoke('markReviewedBulk', { entryIds });
    state.log.pendingReview = result.pendingReview ?? [];
    state.selectedPendingIds = new Set();
    state.reviewReport = { ok: true, reviewed: result.reviewed };
  } catch (error) {
    state.reviewReport = { ok: false, error: error?.message ?? 'Could not mark those reviewed.' };
  } finally {
    state.bulkReviewing = false;
    render();
  }
}

/* ------------------------------------------------------------------ exports -- */

/**
 * Hands a generated file to the browser.
 *
 * Note for anyone debugging this: a sandboxed iframe that disallows downloads
 * swallows the click silently — no exception, no event. So a failure here
 * cannot be detected from inside the page, and the UI says where the file
 * should have gone rather than claiming success.
 */
function downloadBytes(bytes, filename) {
  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';

  // Anchored in the document: a detached node's click is ignored in some
  // sandboxed contexts.
  document.body.appendChild(link);
  link.click();

  // Revoked late. Revoking in the same tick cancels the download in Safari and
  // occasionally in Chrome under load.
  setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 30000);
}

function exportWorkbook({ sheetName, columns, rows, prefix, label, suffix = '' }) {
  state.exportError = null;

  if (rows.length === 0) {
    state.exportError = `There is nothing in ${label} to export yet.`;
    render();
    return;
  }

  try {
    downloadBytes(
      buildWorkbook({ sheetName, columns, rows }),
      exportFileName(prefix, new Date(), suffix),
    );
  } catch (error) {
    state.exportError = `Could not build the ${label} export: ${error?.message ?? 'unknown error'}`;
  }

  render();
}

function exportRemovalLog(entries, suffix = '') {
  exportWorkbook({
    sheetName: 'Removal Log',
    columns: REMOVAL_LOG_COLUMNS,
    rows: removalLogRows(entries),
    prefix: 'worklog-removal-log',
    label: 'the Removal Log',
    suffix,
  });
}

function exportPendingReview(entries, suffix = '') {
  exportWorkbook({
    sheetName: 'Pending Review',
    columns: PENDING_REVIEW_COLUMNS,
    rows: pendingReviewRows(entries),
    prefix: 'worklog-pending-review',
    label: 'Pending review',
    suffix,
  });
}

/**
 * Month + author filter bar for an audit table.
 *
 * Options come from the unfiltered dataset so choosing a month never empties
 * the author list and strands the user. Changing either filter resets to page 1
 * and clears the selection — carrying a hidden selection into a bulk action is
 * exactly the kind of thing that removes 1,542 worklogs.
 */
function filterBar({ which, all, dateField, dateLabel, noun }) {
  const filters = state.logFilters[which];
  const months = monthOptions(all, dateField);
  const authors = authorOptions(all);
  const shown = applyFilters(all, filters, { dateField }).length;

  const change = (patch) => {
    state.logFilters[which] = { ...filters, ...patch };
    state.logPage[which] = 1;
    if (which === 'removals') state.selectedEntryIds = new Set();
    else state.selectedPendingIds = new Set();
    render();
  };

  return el('div', { class: 'wrm-filters' }, [
    el('span', { class: 'wrm-filters__label', text: dateLabel }),
    select({
      value: filters.month,
      options: [{ value: '', label: 'All months' }, ...months],
      onChange: (value) => change({ month: value }),
    }),
    el('span', { class: 'wrm-filters__label', text: 'User' }),
    select({
      value: filters.author,
      options: [{ value: '', label: 'All users' }, ...authors],
      onChange: (value) => change({ author: value }),
    }),
    el('span', { class: 'wrm-pager__spacer' }),
    hasActiveFilters(filters)
      ? el('span', {
          class: 'wrm-filters__count',
          text: `${shown} of ${all.length} ${noun}`,
        })
      : null,
    hasActiveFilters(filters)
      ? el('button', {
          type: 'button',
          class: 'wrm-btn wrm-btn--subtle',
          text: 'Clear filters',
          on: { click: () => change({ month: '', author: '' }) },
        })
      : null,
  ]);
}

/** Shared download button, so both sections stay visually identical. */
function exportButton(count, onClick) {
  return el('button', {
    type: 'button',
    class: 'wrm-btn wrm-btn--subtle',
    text: 'Download Excel (' + count + ')',
    disabled: count === 0,
    attrs: {
      title:
        count === 0
          ? 'Nothing to export yet.'
          : 'Downloads all ' + count + ' row(s) as an .xlsx workbook — not just this page.',
    },
    on: { click: onClick },
  });
}

function switchTab(tab) {
  if (tab === state.tab) return;

  // Tab switches used to discard unsaved edits silently.
  const blocked =
    (state.tab === 'rules' && rulesDirty()) || (state.tab === 'projects' && projectsDirty());

  if (blocked && !state.tabWarning) {
    state.tabWarning = tab;
    render();
    return;
  }

  if (state.tab === 'rules' && rulesDirty()) state.draft = { ...state.config };
  if (state.tab === 'projects' && projectsDirty()) state.projectEdits = {};

  state.tabWarning = null;
  state.tab = tab;
  state.rulesMessage = null;
  state.projectsMessage = null;
  state.pendingBulk = null;
  render();

  if (tab === 'projects') loadProjects();
  if (tab === 'log') loadLog();
}

function updateDraft(patch) {
  state.draft = { ...state.draft, ...patch };
  state.rulesMessage = null;
  // Clear the errors for whatever the admin just touched.
  for (const key of Object.keys(patch)) delete state.ruleErrors[key];
  render();
  if (state.draft.period === PERIOD.AFTER_TRANSITION) loadStatuses();
}

/* ------------------------------------------------------------------- chrome -- */

function header() {
  const icon = el('div', { class: 'wrm-header__icon' });
  icon.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm1 5v5.6l4.2 2.5-.8 1.3-5-3V7Z"/></svg>';

  return el('div', { class: 'wrm-header' }, [
    icon,
    el('div', {}, [
      el('h1', { class: 'wrm-header__title', text: 'Worklog Restriction Manager' }),
      el('p', { class: 'wrm-header__subtitle', text: 'Admin Console' }),
    ]),
  ]);
}

function tabBar() {
  return el(
    'div',
    { class: 'wrm-tabs', attrs: { role: 'tablist' } },
    TABS.map((tab) =>
      el('button', {
        type: 'button',
        class: 'wrm-tab',
        text: tab.label,
        attrs: { role: 'tab', 'aria-selected': String(tab.id === state.tab) },
        on: { click: () => switchTab(tab.id) },
      }),
    ),
  );
}

function unsavedWarning() {
  if (!state.tabWarning) return null;
  const target = TABS.find((tab) => tab.id === state.tabWarning);
  return confirmBar({
    message: `You have unsaved changes on this tab. Leaving for ${target.label} discards them.`,
    confirmLabel: 'Discard changes',
    onConfirm: () => switchTab(state.tabWarning),
    onCancel: () => {
      state.tabWarning = null;
      render();
    },
  });
}

/* -------------------------------------------------------- tab: restriction -- */

function transitionSubform() {
  const statusOptions = [
    { value: '', label: '— Select a status —' },
    ...state.statuses.items.map((status) => ({ value: status.id, label: status.name })),
  ];

  const statusControl = () => {
    if (state.statuses.phase === 'loading') return spinner('Loading statuses…');
    if (state.statuses.phase === 'error') {
      return el('div', {}, [
        el('p', { class: 'wrm-error', text: state.statuses.error }),
        el('button', {
          type: 'button',
          class: 'wrm-btn wrm-btn--subtle',
          text: 'Retry',
          on: {
            click: () => {
              state.statuses = { phase: 'idle', items: [], error: null };
              loadStatuses();
            },
          },
        }),
      ]);
    }
    return select({
      value: state.draft.targetStatusId ?? '',
      options: statusOptions,
      invalid: Boolean(state.ruleErrors.targetStatusName),
      ariaDescribedBy: state.ruleErrors.targetStatusName ? 'wrm-status-error' : null,
      onChange: (value) => {
        const match = state.statuses.items.find((status) => status.id === value);
        updateDraft({
          targetStatusId: match?.id ?? null,
          targetStatusName: match?.name ?? null,
        });
      },
    });
  };

  return el('div', { class: 'wrm-card' }, [
    el('div', { class: 'wrm-field' }, [
      el('label', { class: 'wrm-label', text: 'Restrict worklogs after transition to' }),
      statusControl(),
      fieldError(state.ruleErrors.targetStatusName, 'wrm-status-error'),
    ]),
    el('div', { class: 'wrm-field' }, [
      el('label', { class: 'wrm-label', text: 'Grace period after transition' }),
      select({
        value: state.draft.transitionGraceHours,
        options: TRANSITION_GRACE_OPTIONS,
        onChange: (value) => updateDraft({ transitionGraceHours: Number(value) }),
      }),
    ]),
    el('label', { class: 'wrm-check' }, [
      el('input', {
        type: 'checkbox',
        checked: state.draft.resetOnReopen,
        on: { change: (event) => updateDraft({ resetOnReopen: event.target.checked }) },
      }),
      'Reset restriction if issue is reopened',
    ]),
  ]);
}

function commentTemplateCard({
  field = 'commentTemplate',
  label = 'System comment template',
  fallback = DEFAULT_COMMENT_TEMPLATE,
  note = 'The author is @mentioned, which is what makes Jira email them. Everyone who can browse the issue can see the comment.',
} = {}) {
  const template = state.draft[field] ?? '';
  const textarea = el('textarea', {
    class: 'wrm-textarea',
    value: template,
    attrs: {
      maxlength: String(COMMENT_TEMPLATE_MAX),
      'aria-label': 'System comment template',
      'aria-invalid': state.ruleErrors.commentTemplate ? 'true' : null,
    },
    on: {
      input: (event) => {
        state.draft = { ...state.draft, [field]: event.target.value };
        delete state.ruleErrors[field];
        state.rulesMessage = null;
        renderTemplatePreview();
        renderSaveBar();
      },
    },
  });

  const insertToken = (token) => {
    const marker = `{{${token}}}`;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const next = textarea.value.slice(0, start) + marker + textarea.value.slice(end);
    if (next.length > COMMENT_TEMPLATE_MAX) return;
    textarea.value = next;
    textarea.focus();
    textarea.setSelectionRange(start + marker.length, start + marker.length);
    state.draft = { ...state.draft, [field]: next };
    state.rulesMessage = null;
    renderTemplatePreview();
    renderSaveBar();
  };

  const counter = el('p', { class: 'wrm-counter' });
  const preview = el('div', { class: 'wrm-preview' });

  function renderTemplatePreview() {
    const current = state.draft[field] ?? '';
    counter.textContent = `${current.length} / ${COMMENT_TEMPLATE_MAX}`;
    counter.className =
      current.length > COMMENT_TEMPLATE_MAX ? 'wrm-counter wrm-counter--over' : 'wrm-counter';

    clear(preview);
    // Highlight each substituted value so it is obvious what the token became.
    const rendered = renderCommentTemplate(current, PREVIEW_VALUES);
    const values = Object.values(PREVIEW_VALUES).filter(Boolean).sort((a, b) => b.length - a.length);
    const pattern = values.length
      ? new RegExp(`(${values.map(escapeRegExp).join('|')})`, 'g')
      : null;

    const parts = pattern ? rendered.split(pattern) : [rendered];
    for (const part of parts) {
      if (!part) continue;
      if (pattern && values.includes(part)) {
        preview.append(el('span', { class: 'wrm-mention', text: part }));
      } else {
        preview.append(document.createTextNode(part));
      }
    }
  }

  renderTemplatePreview();

  return el('div', { class: 'wrm-card' }, [
    el('div', { class: 'wrm-card__head' }, [
      el('span', { class: 'wrm-label', text: label }),
      el('button', {
        type: 'button',
        class: 'wrm-link',
        text: 'Reset to default',
        on: {
          click: () => {
            textarea.value = fallback;
            state.draft = { ...state.draft, [field]: fallback };
            delete state.ruleErrors[field];
            state.rulesMessage = null;
            renderTemplatePreview();
            renderSaveBar();
          },
        },
      }),
    ]),
    textarea,
    counter,
    fieldError(state.ruleErrors[field]),
    el('p', { class: 'wrm-label', text: 'Available tokens', style: 'margin-top:12px' }),
    el(
      'div',
      { class: 'wrm-tokens' },
      COMMENT_TOKENS.map((token) =>
        el('button', {
          type: 'button',
          class: 'wrm-token',
          text: `{{${token}}}`,
          attrs: { title: `Insert {{${token}}}` },
          on: { click: () => insertToken(token) },
        }),
      ),
    ),
    el('p', { class: 'wrm-label', text: 'Live preview' }),
    preview,
    el('p', {
      class: 'wrm-footnote',
      text: 'Highlighted values are examples, substituted when the comment is posted. ' + note,
    }),
  ]);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let saveBarNode = null;

function renderSaveBar() {
  if (!saveBarNode) return;
  clear(saveBarNode);
  const dirty = rulesDirty();
  saveBarNode.append(
    el('button', {
      type: 'button',
      class: 'wrm-btn',
      text: state.savingRules ? 'Saving…' : 'Save configuration',
      disabled: state.savingRules || !dirty,
      on: { click: saveRules },
    }),
  );
  if (state.rulesMessage) {
    saveBarNode.append(
      el('span', {
        class: `wrm-status wrm-status--${state.rulesMessage.tone}`,
        text: state.rulesMessage.text,
        attrs: { role: 'status' },
      }),
    );
  } else if (dirty) {
    saveBarNode.append(el('span', { class: 'wrm-status', text: 'Unsaved changes' }));
  }
}

/**
 * Says, against today's date, exactly what the selected rule allows and blocks.
 *
 * The labels on their own are ambiguous in a way that costs a month of
 * timesheets if read the wrong way, and no amount of renaming fixes that —
 * so the console answers it outright instead.
 */
function periodExplainer(draft) {
  const { allows, blocks } = describePeriod(draft, new Date());
  if (!allows && !blocks) return null;

  return el('div', { class: 'wrm-explain' }, [
    el('div', { class: 'wrm-explain__row' }, [
      el('span', { class: 'wrm-explain__tag wrm-explain__tag--ok', text: 'Allows' }),
      el('span', { text: allows }),
    ]),
    el('div', { class: 'wrm-explain__row' }, [
      el('span', { class: 'wrm-explain__tag wrm-explain__tag--no', text: 'Blocks' }),
      el('span', { text: blocks }),
    ]),
  ]);
}

/**
 * Shows the grace window and the date it actually lands on.
 *
 * Working-day counting is the sort of rule people agree on in words and
 * disagree on in dates, so the console commits to a date.
 */
function graceExplainer(draft) {
  const { window, deadline } = describeGrace(draft, new Date());

  return el('div', { class: 'wrm-explain' }, [
    el('div', { class: 'wrm-explain__row' }, [
      el('span', { class: 'wrm-explain__tag wrm-explain__tag--ok', text: 'Window' }),
      el('span', { text: window }),
    ]),
    el('div', { class: 'wrm-explain__row' }, [
      el('span', { class: 'wrm-explain__tag wrm-explain__tag--no', text: 'Deadline' }),
      el('span', { text: deadline }),
    ]),
  ]);
}

function rulesTab() {
  const periodOptions = Object.values(PERIOD).map((value) => ({
    value,
    label: PERIOD_LABELS[value],
  }));

  saveBarNode = el('div', { class: 'wrm-actions' });

  const form = el('div', { class: 'wrm-form' }, [
    el('h2', { class: 'wrm-section-title', text: 'Restriction Rules' }),

    el('div', { class: 'wrm-field' }, [
      el('label', { class: 'wrm-label', text: 'Restriction period' }),
      select({
        value: state.draft.period,
        options: periodOptions,
        onChange: (value) => updateDraft({ period: value }),
      }),
      periodExplainer(state.draft),
    ]),

    state.draft.period === PERIOD.AFTER_TRANSITION ? transitionSubform() : null,

    el('div', { class: 'wrm-card' }, [
      el('label', { class: 'wrm-label', text: 'Grace period before enforcement' }),
      select({
        value: graceToken(state.draft),
        options: graceOptions(),
        onChange: (value) => updateDraft(graceFromToken(value)),
      }),
      graceExplainer(state.draft),
      el('p', {
        class: 'wrm-hint',
        text:
          'Counted from the moment the worklog breached the policy — not from when this ' +
          'app first noticed it. A worklog logged on the 1st under "Last 1 Week" breaches ' +
          'on the 8th, so a 48 hour grace expires on the 10th. Violations already older ' +
          'than this window are enforced on sight. Applies to all restriction period ' +
          'types, independently of the per-transition grace above.',
      }),
    ]),

    state.draft.action === ACTION.DELETE
      ? commentTemplateCard()
      : el('div', {}, [
          el('div', { class: 'wrm-card' }, [
            el('label', { class: 'wrm-check' }, [
              el('input', {
                type: 'checkbox',
                checked: state.draft.commentOnFlag,
                on: { change: (event) => updateDraft({ commentOnFlag: event.target.checked }) },
              }),
              'Also comment on the issue when a worklog is flagged',
            ]),
            el('p', {
              class: 'wrm-hint',
              text:
                'Off means only admins ever see a flag — the person who logged the time is ' +
                'never told. On posts a notice that @mentions them, without deleting anything.',
            }),
          ]),
          state.draft.commentOnFlag
            ? commentTemplateCard({
                field: 'flagCommentTemplate',
                label: 'Flag notification template',
                fallback: DEFAULT_FLAG_COMMENT_TEMPLATE,
                note:
                  'Posted when a worklog is flagged. Nothing is deleted in this mode, so the ' +
                  'wording should not say otherwise.',
              })
            : null,
        ]),

    el('div', { class: 'wrm-field' }, [
      el('span', { class: 'wrm-label', text: 'Enforcement action' }),
      el(
        'div',
        { class: 'wrm-radio-group' },
        Object.values(ACTION).map((value) =>
          el('label', { class: 'wrm-radio' }, [
            el('input', {
              type: 'radio',
              name: 'wrm-action',
              value,
              checked: state.draft.action === value,
              on: { change: () => updateDraft({ action: value }) },
            }),
            ACTION_LABELS[value],
          ]),
        ),
      ),
    ]),

    saveBarNode,
  ]);

  renderSaveBar();
  return form;
}

/* ------------------------------------------------------------ tab: projects -- */

function projectsTab() {
  if (state.projects.phase === 'loading' || state.projects.phase === 'idle') {
    return spinner('Loading projects…');
  }

  if (state.projects.phase === 'error') {
    return el('div', {}, [
      el('p', { class: 'wrm-error', text: state.projects.error }),
      el('button', {
        type: 'button',
        class: 'wrm-btn wrm-btn--subtle',
        text: 'Retry',
        on: {
          click: () => {
            state.projects = { phase: 'idle', items: [], error: null };
            loadProjects();
          },
        },
      }),
    ]);
  }

  const matches = filteredProjects();
  const scoped = state.projectQuery.trim() !== '';
  const totalPages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const page = Math.min(state.projectPage, totalPages);
  const visible = matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const searchInput = el('input', {
    class: 'wrm-input',
    type: 'search',
    value: state.projectQuery,
    attrs: { placeholder: 'Search by name or key…', 'aria-label': 'Search projects' },
    on: {
      input: (event) => {
        state.projectQuery = event.target.value;
        state.projectPage = 1;
        state.pendingBulk = null;
        render();
        // Keep focus and caret while retyping.
        const next = document.querySelector('.wrm-toolbar .wrm-input');
        if (next) {
          next.focus();
          next.setSelectionRange(next.value.length, next.value.length);
        }
      },
    },
  });

  // Buttons name their scope, so a filtered bulk action cannot surprise anyone.
  const bulkSuffix = scoped ? ` (${matches.length} shown)` : ` (all ${matches.length})`;

  const toolbar = el('div', { class: 'wrm-toolbar' }, [
    searchInput,
    el('div', { class: 'wrm-toolbar__btns' }, [
      el('button', {
        type: 'button',
        class: 'wrm-btn wrm-btn--positive',
        text: `Enable all${bulkSuffix}`,
        disabled: matches.length === 0,
        on: { click: () => requestBulk(true) },
      }),
      el('button', {
        type: 'button',
        class: 'wrm-btn wrm-btn--subtle',
        text: `Disable all${bulkSuffix}`,
        disabled: matches.length === 0,
        on: { click: () => requestBulk(false) },
      }),
    ]),
  ]);

  const rows = visible.map((project) => {
    const enabled = projectEnabled(project);
    const changed = state.projectEdits[project.key] !== undefined;
    return el('tr', {}, [
      el('td', {}, [
        el('div', { class: 'wrm-project' }, [
          projectAvatar(project),
          el('span', { text: project.name }),
          changed ? badge('changed', 'amber') : null,
        ]),
      ]),
      el('td', {}, [el('span', { class: 'wrm-key', text: project.key })]),
      el('td', {}, [
        enabled ? badge('Restricted', 'green') : badge('Unrestricted', 'grey'),
      ]),
      el('td', { class: 'wrm-table__actions' }, [
        toggle({
          checked: enabled,
          label: `Restrictions for ${project.name}`,
          onChange: (value) => {
            if (project.isEnabled === value) delete state.projectEdits[project.key];
            else state.projectEdits[project.key] = value;
            state.projectsMessage = null;
            render();
          },
        }),
      ]),
    ]);
  });

  const table = el('div', { class: 'wrm-card wrm-card--flush' }, [
    el('table', { class: 'wrm-table' }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Project' }),
          el('th', { text: 'Key' }),
          el('th', { text: 'Status' }),
          el('th', { class: 'wrm-table__actions', text: 'Restrictions' }),
        ]),
      ]),
      rows.length
        ? el('tbody', {}, rows)
        : el('tbody', {}, [
            el('tr', {}, [
              el('td', { class: 'wrm-empty', attrs: { colspan: 4 } }, [
                state.projects.items.length === 0
                  ? 'No projects found on this site.'
                  : `No projects match “${state.projectQuery}”.`,
              ]),
            ]),
          ]),
    ]),
  ]);

  const dirty = projectsDirty();
  const changedCount = Object.keys(state.projectEdits).length;

  return el('div', {}, [
    el('h2', { class: 'wrm-section-title', text: 'Projects' }),
    toolbar,
    state.pendingBulk
      ? confirmBar({
          message:
            `This enables automatic enforcement on ${state.pendingBulk.count} project` +
            `${state.pendingBulk.count === 1 ? '' : 's'}` +
            `${state.pendingBulk.scoped ? ' matching the current search' : ''}. ` +
            (state.draft.action === ACTION.DELETE
              ? 'The current action is Delete, so violating worklogs will be removed.'
              : 'The current action is Flag only, so nothing will be deleted.'),
          confirmLabel: `Enable ${state.pendingBulk.count}`,
          onConfirm: () => applyBulk(true),
          onCancel: () => {
            state.pendingBulk = null;
            render();
          },
        })
      : null,
    table,
    pager(page, totalPages, matches.length),
    el('div', { class: 'wrm-actions' }, [
      el('button', {
        type: 'button',
        class: 'wrm-btn',
        text: state.savingProjects ? 'Saving…' : 'Save',
        disabled: state.savingProjects || !dirty,
        on: { click: saveProjects },
      }),
      state.projectsMessage
        ? el('span', {
            class: `wrm-status wrm-status--${state.projectsMessage.tone}`,
            text: state.projectsMessage.text,
            attrs: { role: 'status' },
          })
        : dirty
          ? el('span', {
              class: 'wrm-status',
              text: `${changedCount} unsaved change${changedCount === 1 ? '' : 's'}`,
            })
          : null,
    ]),
  ]);
}

/**
 * Page controls for any table.
 *
 * Shared by the projects list and both log tables, so page-size handling and
 * the windowed page numbers stay consistent instead of being reimplemented.
 */
function paginator({ page, total, pageSize, onGoto, noun = 'rows' }) {
  if (total === 0) return null;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, totalPages);
  const first = (current - 1) * pageSize + 1;
  const last = Math.min(current * pageSize, total);

  const buttons = [];
  if (totalPages > 1) {
    buttons.push(
      el('button', {
        type: 'button',
        class: 'wrm-pager__btn',
        text: 'Prev',
        disabled: current === 1,
        on: { click: () => onGoto(current - 1) },
      }),
    );

    // Windowed, so hundreds of rows do not produce a wall of page buttons.
    const windowSize = 5;
    const end = Math.min(totalPages, Math.max(1, current - Math.floor(windowSize / 2)) + windowSize - 1);
    const start = Math.max(1, end - windowSize + 1);

    for (let index = start; index <= end; index += 1) {
      buttons.push(
        el('button', {
          type: 'button',
          class: 'wrm-pager__btn',
          text: String(index),
          attrs: { 'aria-current': String(index === current) },
          on: { click: () => onGoto(index) },
        }),
      );
    }

    buttons.push(
      el('button', {
        type: 'button',
        class: 'wrm-pager__btn',
        text: 'Next',
        disabled: current === totalPages,
        on: { click: () => onGoto(current + 1) },
      }),
    );
  }

  return el('div', { class: 'wrm-pager' }, [
    el('span', { text: `Showing ${first}–${last} of ${total} ${noun}` }),
    el('span', { class: 'wrm-pager__spacer' }),
    buttons.length ? el('div', { class: 'wrm-pager__pages' }, buttons) : null,
  ]);
}

/**
 * Collapsible section heading.
 *
 * Both log tables grow without bound, so each one folds away. The count stays
 * visible while collapsed — collapsing should hide the rows, not the fact that
 * there are rows.
 */
function collapsibleHeading({ title, count, open, onToggle, suffix }) {
  return el('div', { class: 'wrm-collapse-head' }, [
    el('button', {
      type: 'button',
      class: 'wrm-collapse-btn',
      attrs: { 'aria-expanded': String(open) },
      on: { click: onToggle },
    }, [
      el('span', { class: 'wrm-collapse-caret', text: open ? '▾' : '▸' }),
      el('span', { class: 'wrm-section-title', text: title }),
      el('span', { class: 'wrm-collapse-count', text: String(count) }),
    ]),
    suffix ?? null,
  ]);
}

/** Clickable timestamp header that toggles sort direction. */
function sortableHeader({ label, direction, onToggle, className }) {
  return el('th', { class: className }, [
    el('button', {
      type: 'button',
      class: 'wrm-sort-btn',
      attrs: {
        'aria-sort': direction === 'asc' ? 'ascending' : 'descending',
        title: `Sort by ${label.toLowerCase()} (${direction === 'asc' ? 'oldest' : 'newest'} first)`,
      },
      on: { click: onToggle },
    }, [label, el('span', { class: 'wrm-sort-caret', text: direction === 'asc' ? '▲' : '▼' })]),
  ]);
}
function pager(page, totalPages, total) {
  // Thin wrapper kept so the projects tab reads unchanged.
  return paginator({
    page,
    total,
    pageSize: PAGE_SIZE,
    noun: 'projects',
    onGoto: (next) => {
      state.projectPage = next;
      render();
    },
  });
}


/* ------------------------------------------------------------- tab: preview -- */

function previewTab() {
  const config = state.config;
  const validation = validateConfig(config);
  const rows = [];

  const addRow = (label, value) =>
    rows.push(el('tr', {}, [el('th', { text: label }), el('td', {}, [value])]));

  addRow('Restriction period', el('span', { text: PERIOD_LABELS[config.period] }));

  if (config.period === PERIOD.AFTER_TRANSITION) {
    addRow(
      'Target status',
      config.targetStatusName
        ? el('span', { text: config.targetStatusName })
        : el('span', { class: 'wrm-error', text: '— not set —' }),
    );
    addRow(
      'Grace period',
      el('span', {
        text:
          TRANSITION_GRACE_OPTIONS.find((o) => o.value === config.transitionGraceHours)?.label ??
          `${config.transitionGraceHours} hours`,
      }),
    );
    addRow('Reset on reopen', el('span', { text: config.resetOnReopen ? 'Yes' : 'No' }));
  }

  addRow(
    'Grace before enforcement',
    el('span', {
      // Reads the same token the form writes, so this row cannot report hours
      // while a working-day grace is the one actually in force.
      text:
        graceOptions().find((o) => o.value === graceToken(config))?.label ??
        `${config.enforcementGraceHours} hours`,
    }),
  );
  addRow('Enforcement action', el('span', { text: ACTION_LABELS[config.action] }));
  addRow(
    'Enabled projects',
    el('span', {
      text: `${config.enabledProjects.length} project${config.enabledProjects.length === 1 ? '' : 's'}`,
    }),
  );
  addRow(
    'Applies to worklogs logged',
    config.effectiveFrom
      ? el('span', { text: `on or after ${formatTimestamp(config.effectiveFrom)}` })
      : el('span', { text: '— set when you first save these rules —' }),
  );

  const warnings = [];
  if (!validation.ok) {
    warnings.push(
      el('div', { class: 'wrm-banner wrm-banner--red' }, [
        el('div', { class: 'wrm-banner__title' }, ['⚠', ' This configuration is inactive']),
        el('div', {
          text:
            'Nothing will be enforced until it is fixed: ' +
            Object.values(validation.errors).join(' '),
        }),
      ]),
    );
  } else if (config.enabledProjects.length === 0) {
    warnings.push(
      el('div', { class: 'wrm-banner wrm-banner--grey' }, [
        el('div', { class: 'wrm-banner__title' }, ['ℹ', ' No projects enabled']),
        el('div', {
          text: 'The rule is valid but no project has opted in, so no worklogs are checked.',
        }),
      ]),
    );
  }

  if (validation.ok && config.action === ACTION.DELETE && config.enabledProjects.length > 0) {
    warnings.push(
      el('div', { class: 'wrm-banner wrm-banner--amber' }, [
        el('div', { class: 'wrm-banner__title' }, ['⚠', ' Deletion is active']),
        el('div', {
          text:
            `Violating worklogs in ${config.enabledProjects.length} project` +
            `${config.enabledProjects.length === 1 ? '' : 's'} are deleted automatically ` +
            'once the grace period expires. Deletion cannot be undone.',
        }),
      ]),
    );
  }

  return el('div', {}, [
    el('h2', { class: 'wrm-section-title', text: 'Active Configuration Summary' }),
    ...warnings,
    el('div', { class: 'wrm-card wrm-card--flush' }, [
      el('table', { class: 'wrm-summary' }, [el('tbody', {}, rows)]),
    ]),
  ]);
}

/* ----------------------------------------------------------------- tab: log -- */

/**
 * Reports what a restore actually did.
 *
 * Attribution is the part worth surfacing: Jira ignores any author sent in the
 * request body, so a restore can succeed while silently crediting the app
 * rather than the person who logged the time. This reads back the account id
 * Jira recorded and says plainly whether it matched.
 */
function restoreReportBanner() {
  const report = state.restoreReport;
  if (!report) return null;

  if (!report.ok) {
    return el('div', { class: 'wrm-banner wrm-banner--red' }, [
      el('div', { class: 'wrm-banner__title' }, ['⚠', ' Restore failed']),
      el('div', { text: report.error ?? 'Unknown error.' }),
      el('p', {
        class: 'wrm-footnote',
        text:
          'A 403 here usually means impersonation is not permitted for that author — a privately installed app can only impersonate app contributors.',
      }),
    ]);
  }

  if (report.markedOnly) {
    return el('div', { class: 'wrm-banner wrm-banner--green' }, [
      el('div', { class: 'wrm-banner__title' }, ['✓', ' Marked as already restored']),
      el('div', {
        text:
          report.markedOnly +
          ' entr' +
          (report.markedOnly === 1 ? 'y' : 'ies') +
          ' will now be skipped by a bulk restore. Nothing was written to Jira.',
      }),
    ]);
  }

  if (report.attributedToOriginalAuthor) {
    return el('div', { class: 'wrm-banner wrm-banner--green' }, [
      el('div', { class: 'wrm-banner__title' }, ['✓', ' Restored to the original author']),
      el('div', {
        text:
          report.issueKey +
          ': Jira recorded the worklog under the original author. ' +
          (report.remaining ?? 0) +
          ' deletion(s) still un-restored.',
      }),
    ]);
  }

  return el('div', { class: 'wrm-banner wrm-banner--amber' }, [
    el('div', { class: 'wrm-banner__title' }, ['⚠', ' Restored, but attributed to the app']),
    el('div', {
      text:
        report.issueKey +
        ': the worklog is back, but Jira credited ' +
        (report.recordedAuthorAccountId ?? 'an unknown account') +
        ' instead of ' +
        (report.expectedAuthorAccountId ?? 'the original author') +
        '. Impersonation did not take effect.',
    }),
    el('p', {
      class: 'wrm-footnote',
      text: 'Hours and dates are correct; only authorship is wrong. Delete and re-log manually if attribution matters.',
    }),
  ]);
}

function restoreToolbar(entries) {
  const outstanding = entries.filter((entry) => !entry.restoredAt);
  const selected = outstanding.filter((entry) => state.selectedEntryIds.has(entry.id));
  const busy = state.bulkRestore !== null || state.restoringId !== null;

  if (outstanding.length === 0) {
    return el('div', { class: 'wrm-pager' }, [
      el('span', { text: 'Every recorded deletion has been restored.' }),
    ]);
  }

  return el('div', { class: 'wrm-toolbar' }, [
    el('span', {
      class: 'wrm-status',
      text:
        outstanding.length +
        ' un-restored, ' +
        selected.length +
        ' selected',
    }),
    el('span', { class: 'wrm-pager__spacer' }),
    el('div', { class: 'wrm-toolbar__btns' }, [
      el('button', {
        type: 'button',
        class: 'wrm-btn wrm-btn--subtle',
        text: 'Restore selected (' + selected.length + ')',
        disabled: busy || selected.length === 0,
        on: { click: () => restoreMany(selected.map((e) => e.id), 'selected') },
      }),
      el('button', {
        type: 'button',
        class: 'wrm-btn wrm-btn--subtle',
        text: 'Mark selected as already restored (' + selected.length + ')',
        disabled: busy || selected.length === 0,
        attrs: {
          title:
            'Writes nothing to Jira. Use for worklogs you already re-entered by hand, so a bulk restore skips them.',
        },
        on: { click: () => markSelectedExternallyRestored(selected.map((e) => e.id)) },
      }),
      el('button', {
        type: 'button',
        class: 'wrm-btn',
        // "All" means all that the filters select, which is what is on screen.
        text:
          (hasActiveFilters(state.logFilters.removals) ? 'Restore all filtered (' : 'Restore all (') +
          outstanding.length +
          ')',
        disabled: busy,
        on: {
          click: () => {
            state.pendingBulkRestore = {
              ids: outstanding.map((e) => e.id),
              scope: describeFilters(state.logFilters.removals, state.log.removalLog),
            };
            render();
          },
        },
      }),
    ]),
  ]);
}

function bulkProgress() {
  const bulk = state.bulkRestore;
  if (!bulk) return null;
  return el('div', { class: 'wrm-banner wrm-banner--grey' }, [
    el('div', { class: 'wrm-banner__title' }, ['Restoring ' + bulk.label]),
    el('div', { class: 'wrm-spinner-row' }, [
      el('span', { class: 'wrm-spinner' }),
      el('span', { text: bulk.done + ' of ' + bulk.total + ' processed — leave this tab open.' }),
    ]),
  ]);
}

function reviewToolbar(entries) {
  const selected = entries.filter((entry) => state.selectedPendingIds.has(entry.id));
  const busy = state.bulkReviewing || state.reviewingId !== null;

  if (entries.length === 0) return null;

  return el('div', { class: 'wrm-toolbar' }, [
    el('span', {
      class: 'wrm-status',
      text: entries.length + ' flagged, ' + selected.length + ' selected',
    }),
    el('span', { class: 'wrm-pager__spacer' }),
    el('div', { class: 'wrm-toolbar__btns' }, [
      el('button', {
        type: 'button',
        class: 'wrm-btn wrm-btn--subtle',
        text: state.bulkReviewing
          ? 'Working…'
          : 'Mark selected reviewed (' + selected.length + ')',
        disabled: busy || selected.length === 0,
        on: {
          click: () => {
            state.pendingBulkReview = { ids: selected.map((e) => e.id), scope: 'the selected rows' };
            render();
          },
        },
      }),
      el('button', {
        type: 'button',
        class: 'wrm-btn',
        text:
          (hasActiveFilters(state.logFilters.pending)
            ? 'Mark all filtered reviewed ('
            : 'Mark all reviewed (') +
          entries.length +
          ')',
        disabled: busy,
        on: {
          click: () => {
            state.pendingBulkReview = {
              ids: entries.map((e) => e.id),
              scope: describeFilters(state.logFilters.pending, state.log.pendingReview),
            };
            render();
          },
        },
      }),
    ]),
  ]);
}

/**
 * Confirms a bulk review.
 *
 * Reviewing is one-way — the queue entry is the only record of the flag, and
 * clearing it discards that record. Nothing in Jira changes, so nobody notices
 * a mistake later. Hence the confirm, and the pointed suggestion to export
 * first.
 */
function bulkReviewConfirm() {
  const pending = state.pendingBulkReview;
  if (!pending) return null;

  return confirmBar({
    message:
      'This clears ' +
      pending.ids.length +
      ' entr' +
      (pending.ids.length === 1 ? 'y' : 'ies') +
      ' from the review queue, covering ' +
      (pending.scope ?? 'all entries') +
      '. Nothing in Jira changes — the worklogs stay exactly as they are — ' +
      'but the record that they were flagged is discarded and cannot be recovered. ' +
      'Download the Excel export first if you need to keep it.',
    confirmLabel: 'Mark ' + pending.ids.length + ' reviewed',
    onConfirm: () => markReviewedBulk(pending.ids),
    onCancel: () => {
      state.pendingBulkReview = null;
      render();
    },
  });
}

function reviewReportBanner() {
  const report = state.reviewReport;
  if (!report) return null;

  if (!report.ok) {
    return el('div', { class: 'wrm-banner wrm-banner--red' }, [
      el('div', { class: 'wrm-banner__title' }, ['⚠', ' Bulk review failed']),
      el('div', { text: report.error }),
    ]);
  }

  return el('div', { class: 'wrm-banner wrm-banner--green' }, [
    el('div', { class: 'wrm-banner__title' }, ['✓', ' Marked reviewed']),
    el('div', {
      text:
        report.reviewed +
        ' entr' +
        (report.reviewed === 1 ? 'y' : 'ies') +
        ' cleared from the queue. No worklogs were changed.',
    }),
  ]);
}

/**
 * Only ever shown for a failure. A successful download is its own feedback, and
 * a browser that blocks the download gives this page no signal to report.
 */
function exportErrorBanner() {
  if (!state.exportError) return null;
  return el('div', { class: 'wrm-banner wrm-banner--amber' }, [
    el('div', { class: 'wrm-banner__title' }, ['⚠', ' Export not produced']),
    el('div', { text: state.exportError }),
  ]);
}

function bulkConfirm() {
  const pending = state.pendingBulkRestore;
  if (!pending) return null;
  return confirmBar({
    message:
      'This re-creates ' +
      pending.ids.length +
      ' worklog(s) in Jira, covering ' +
      (pending.scope ?? 'all entries') +
      '. Restoring is not instant — it runs in batches and this tab must stay open. ' +
      'Entries already restored are skipped, so it is safe to re-run.',
    confirmLabel: 'Restore ' + pending.ids.length,
    onConfirm: () => restoreMany(pending.ids, 'all outstanding'),
    onCancel: () => {
      state.pendingBulkRestore = null;
      render();
    },
  });
}

function logTab() {
  if (state.log.phase === 'loading' || state.log.phase === 'idle') {
    return spinner('Loading removal log…');
  }

  if (state.log.phase === 'error') {
    return el('div', {}, [
      el('p', { class: 'wrm-error', text: state.log.error }),
      el('button', {
        type: 'button',
        class: 'wrm-btn wrm-btn--subtle',
        text: 'Retry',
        on: {
          click: () => {
            state.log = { phase: 'idle', removalLog: [], pendingReview: [], error: null };
            loadLog();
          },
        },
      }),
    ]);
  }

  const stats = summariseRemovals(state.log.removalLog, new Date());

  const statCard = (value, label, scope) =>
    el('div', { class: 'wrm-stat' }, [
      el('div', { class: 'wrm-stat__value', text: value }),
      el('div', { class: 'wrm-stat__label', text: label }),
      scope ? el('div', { class: 'wrm-stat__scope', text: scope }) : null,
    ]);

  // `entries` is the filtered set from here down, so the table, the row count,
  // the export and every bulk action are talking about the same rows.
  const allRemovals = state.log.removalLog;
  const entries = applyFilters(allRemovals, state.logFilters.removals, {
    dateField: 'worklogStarted',
  }).sort((a, b) =>
    state.logSort.removals === 'asc'
      ? new Date(a.removedAt) - new Date(b.removedAt)
      : new Date(b.removedAt) - new Date(a.removedAt),
  );

  const removalPages = Math.max(1, Math.ceil(entries.length / LOG_PAGE_SIZE));
  const removalPage = Math.min(state.logPage.removals, removalPages);
  const visibleEntries = entries.slice(
    (removalPage - 1) * LOG_PAGE_SIZE,
    removalPage * LOG_PAGE_SIZE,
  );

  const logRows = visibleEntries.map((entry) =>
    el('tr', {}, [
      el('td', { class: 'wrm-table__actions' }, [
        entry.restoredAt
          ? null
          : el('input', {
              type: 'checkbox',
              checked: state.selectedEntryIds.has(entry.id),
              attrs: { 'aria-label': 'Select ' + entry.issueKey },
              on: { change: (event) => toggleSelected(entry.id, event.target.checked) },
            }),
      ]),
      el('td', { text: formatTimestamp(entry.removedAt) }),
      el('td', {}, [
        el('a', {
          class: 'wrm-issue-link',
          text: entry.issueKey,
          href: `/browse/${entry.issueKey}`,
          target: '_blank',
          rel: 'noopener noreferrer',
        }),
      ]),
      el('td', { text: entry.authorDisplayName || 'Unknown' }),
      el('td', { text: formatDate(entry.worklogStarted) }),
      el('td', { text: entry.timeSpent || '—' }),
      el('td', {}, [badge(entry.ruleViolated || 'Unknown', 'red')]),
      el('td', { class: 'wrm-table__actions' }, [
        entry.restoredAt
          ? badge('Restored', 'green')
          : el('button', {
              type: 'button',
              class: 'wrm-btn wrm-btn--subtle',
              text: state.restoringId === entry.id ? 'Restoring…' : 'Restore',
              disabled: state.restoringId !== null || state.bulkRestore !== null,
              on: { click: () => restoreOne(entry.id) },
            }),
      ]),
    ]),
  );

  const children = [
    bulkConfirm(),
    bulkProgress(),
    restoreReportBanner(),
    exportErrorBanner(),
    el('div', { class: 'wrm-stats' }, [
      statCard(String(stats.removedThisMonth), 'Removed this month', `In ${stats.scopeLabel}`),
      statCard(String(stats.issuesAffected), 'Issues affected', `In ${stats.scopeLabel}`),
      statCard(
        stats.topAuthor ?? '—',
        'Top author',
        stats.topAuthor ? `${stats.topAuthorCount} in ${stats.scopeLabel}` : `In ${stats.scopeLabel}`,
      ),
    ]),
    ...(() => {
      const open = !state.logCollapsed.removals;
      const head = collapsibleHeading({
        title: 'Removal Log',
        count: entries.length,
        open,
        onToggle: () => {
          state.logCollapsed.removals = open;
          render();
        },
        // Stays available while collapsed — exporting is the one thing worth
        // doing without unfolding a few hundred rows first.
        // Exports what the filters select, not the whole log — and the filename
        // records which, so a filtered file cannot be mistaken for a full one.
        suffix: el('div', { class: 'wrm-collapse-head__actions' }, [
          exportButton(entries.length, () =>
            exportRemovalLog(entries, filterFileSuffix(state.logFilters.removals, allRemovals)),
          ),
        ]),
      });
      if (!open) return [head];
      return [
        head,
        filterBar({
          which: 'removals',
          all: allRemovals,
          dateField: 'worklogStarted',
          dateLabel: 'Worklog month',
          noun: 'removals',
        }),
        restoreToolbar(entries),
        el('div', { class: 'wrm-card wrm-card--flush' }, [
          el('table', { class: 'wrm-table' }, [
            el('thead', {}, [
              el('tr', {}, [
                el('th', { class: 'wrm-table__actions' }, [
                  el('input', {
                    type: 'checkbox',
                    attrs: { 'aria-label': 'Select all un-restored rows on this page' },
                    checked:
                      visibleEntries.some((e) => !e.restoredAt) &&
                      visibleEntries.every((e) => e.restoredAt || state.selectedEntryIds.has(e.id)),
                    on: { change: (event) => selectAllVisible(visibleEntries, event.target.checked) },
                  }),
                ]),
                sortableHeader({
                  label: 'Timestamp',
                  direction: state.logSort.removals,
                  onToggle: () => {
                    state.logSort.removals = state.logSort.removals === 'desc' ? 'asc' : 'desc';
                    state.logPage.removals = 1;
                    render();
                  },
                }),
                el('th', { text: 'Issue' }),
                el('th', { text: 'Author' }),
                el('th', { text: 'Worklog date' }),
                el('th', { text: 'Time spent' }),
                el('th', { text: 'Rule violated' }),
                el('th', { class: 'wrm-table__actions', text: 'Restore' }),
              ]),
            ]),
            logRows.length
              ? el('tbody', {}, logRows)
              : el('tbody', {}, [
                  el('tr', {}, [
                    el('td', { class: 'wrm-empty', attrs: { colspan: 8 } }, [
                      'No removals recorded yet.',
                    ]),
                  ]),
                ]),
          ]),
        ]),
        paginator({
          page: state.logPage.removals,
          total: entries.length,
          pageSize: LOG_PAGE_SIZE,
          noun: 'removals',
          onGoto: (next) => {
            state.logPage.removals = next;
            render();
          },
        }),
      ];
    })(),
  ];

  // Only meaningful in flag-only mode, but shown whenever anything is queued so
  // a leftover queue after switching modes cannot go unnoticed.
  if (state.config.action === ACTION.FLAG || state.log.pendingReview.length > 0) {
    const pendingUnfiltered = state.log.pendingReview;
    const pendingAll = applyFilters(pendingUnfiltered, state.logFilters.pending, {
      dateField: 'worklogStarted',
    }).sort((a, b) =>
      state.logSort.pending === 'asc'
        ? new Date(a.flaggedAt) - new Date(b.flaggedAt)
        : new Date(b.flaggedAt) - new Date(a.flaggedAt),
    );
    const pendingPages = Math.max(1, Math.ceil(pendingAll.length / LOG_PAGE_SIZE));
    const pendingPage = Math.min(state.logPage.pending, pendingPages);
    const pendingVisible = pendingAll.slice(
      (pendingPage - 1) * LOG_PAGE_SIZE,
      pendingPage * LOG_PAGE_SIZE,
    );

    const pendingRows = pendingVisible.map((entry) =>
      el('tr', { class: 'wrm-row--pending' }, [
        el('td', { class: 'wrm-table__actions' }, [
          el('input', {
            type: 'checkbox',
            checked: state.selectedPendingIds.has(entry.id),
            attrs: { 'aria-label': 'Select ' + entry.issueKey },
            disabled: state.bulkReviewing,
            on: { change: (event) => togglePendingSelected(entry.id, event.target.checked) },
          }),
        ]),
        el('td', { text: formatTimestamp(entry.flaggedAt) }),
        el('td', {}, [
          el('a', {
            class: 'wrm-issue-link',
            text: entry.issueKey,
            href: `/browse/${entry.issueKey}`,
            target: '_blank',
            rel: 'noopener noreferrer',
          }),
        ]),
        el('td', { text: entry.authorDisplayName || 'Unknown' }),
        el('td', { text: formatDate(entry.worklogStarted) }),
        el('td', { text: entry.timeSpent || '—' }),
        el('td', {}, [badge(entry.ruleViolated || 'Unknown', 'amber')]),
        el('td', { class: 'wrm-table__actions' }, [
          el('button', {
            type: 'button',
            class: 'wrm-btn wrm-btn--subtle',
            text: state.reviewingId === entry.id ? 'Saving…' : 'Mark reviewed',
            disabled: state.reviewingId === entry.id || state.bulkReviewing,
            on: { click: () => markReviewed(entry.id) },
          }),
        ]),
      ]),
    );

    const pendingOpen = !state.logCollapsed.pending;
    children.push(
      collapsibleHeading({
        title: 'Pending review',
        count: pendingAll.length,
        open: pendingOpen,
        onToggle: () => {
          state.logCollapsed.pending = pendingOpen;
          render();
        },
        suffix: el('div', { class: 'wrm-collapse-head__actions' }, [
          exportButton(pendingAll.length, () =>
            exportPendingReview(
              pendingAll,
              filterFileSuffix(state.logFilters.pending, pendingUnfiltered),
            ),
          ),
        ]),
      }),
    );

    if (pendingOpen) {
      children.push(
        reviewReportBanner(),
        bulkReviewConfirm(),
        filterBar({
          which: 'pending',
          all: pendingUnfiltered,
          dateField: 'worklogStarted',
          dateLabel: 'Worklog month',
          noun: 'flagged worklogs',
        }),
        reviewToolbar(pendingAll),
        el('div', { class: 'wrm-card wrm-card--flush' }, [
          el('table', { class: 'wrm-table' }, [
            el('thead', {}, [
              el('tr', {}, [
                el('th', { class: 'wrm-table__actions' }, [
                  el('input', {
                    type: 'checkbox',
                    attrs: { 'aria-label': 'Select all flagged rows on this page' },
                    // Page-scoped, like the Removal Log: a select-all that
                    // silently reached other pages would make bulk review a
                    // much more dangerous button than it looks.
                    checked:
                      pendingVisible.length > 0 &&
                      pendingVisible.every((e) => state.selectedPendingIds.has(e.id)),
                    disabled: state.bulkReviewing,
                    on: {
                      change: (event) => selectAllPendingVisible(pendingVisible, event.target.checked),
                    },
                  }),
                ]),
                sortableHeader({
                  label: 'Flagged',
                  direction: state.logSort.pending,
                  onToggle: () => {
                    state.logSort.pending = state.logSort.pending === 'desc' ? 'asc' : 'desc';
                    state.logPage.pending = 1;
                    render();
                  },
                }),
                el('th', { text: 'Issue' }),
                el('th', { text: 'Author' }),
                el('th', { text: 'Worklog date' }),
                el('th', { text: 'Time spent' }),
                el('th', { text: 'Rule violated' }),
                el('th', { class: 'wrm-table__actions', text: 'Action' }),
              ]),
            ]),
            pendingRows.length
              ? el('tbody', {}, pendingRows)
              : el('tbody', {}, [
                  el('tr', {}, [
                    el('td', { class: 'wrm-empty', attrs: { colspan: 8 } }, ['No pending items.']),
                  ]),
                ]),
          ]),
        ]),
        paginator({
          page: pendingPage,
          total: pendingAll.length,
          pageSize: LOG_PAGE_SIZE,
          noun: 'flagged worklogs',
          onGoto: (next) => {
            state.logPage.pending = next;
            render();
          },
        }),
      );
    }
  }

  return el('div', {}, children);
}

/* ------------------------------------------------------------------ render -- */

function render() {
  clear(root);

  if (state.phase === 'loading') {
    root.append(spinner('Loading…'));
    return;
  }

  if (state.phase === 'denied') {
    root.append(
      el('div', { class: 'wrm-denied' }, [
        el('div', { class: 'wrm-denied__title', text: 'Access Denied' }),
        el('div', {
          class: 'wrm-denied__body',
          text: 'Jira Administrator rights are required to use the Worklog Restriction Manager.',
        }),
      ]),
    );
    return;
  }

  if (state.phase === 'error') {
    root.append(
      el('div', { class: 'wrm-denied' }, [
        el('div', { class: 'wrm-denied__title', text: 'Something went wrong' }),
        el('div', { class: 'wrm-denied__body', text: state.error }),
      ]),
    );
    return;
  }

  const body = el('div', { class: 'wrm-body' });
  const warning = unsavedWarning();
  if (warning) body.append(warning);

  if (state.tab === 'rules') body.append(rulesTab());
  else if (state.tab === 'projects') body.append(projectsTab());
  else if (state.tab === 'preview') body.append(previewTab());
  else body.append(logTab());

  root.append(header(), tabBar(), body);
}

boot();
