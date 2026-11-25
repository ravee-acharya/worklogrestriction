import { invoke, view } from '@forge/bridge';
import { ACTION, STATE, humaniseCountdown } from '../../shared/rules.mjs';
import { badge, clear, el } from '../dom.js';

const root = document.getElementById('root');

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/** Status pill per worklog, mirroring what enforcement actually did. */
function stateBadge(entry, action) {
  if (entry.state === STATE.COMPLIANT) return badge('Compliant', 'green');
  // Breaches the rule but predates it, so it is left alone.
  if (entry.state === STATE.EXEMPT) return badge('Pre-existing', 'grey');
  if (entry.state === STATE.GRACE) return badge('Grace period', 'amber');
  return action === ACTION.FLAG ? badge('Flagged', 'amber') : badge('Removed', 'red');
}

function notActive() {
  return el('div', { class: 'wrm-banner wrm-banner--grey' }, [
    el('div', {
      text:
        'Worklog restrictions not active for this project — historical worklogs can be logged as usual.',
    }),
  ]);
}

function compliant(count) {
  return el('div', { class: 'wrm-banner wrm-banner--green' }, [
    el('div', { class: 'wrm-banner__title' }, ['✓', ' All worklogs compliant']),
    el('div', {
      text: `${count} worklog${count === 1 ? '' : 's'} checked against the active period policy.`,
    }),
  ]);
}

/**
 * Violation banner.
 *
 * Two distinct cases, and the old panel blurred them: a violation still inside
 * its grace window is a warning about something that *will* happen, while an
 * expired one describes something that already has.
 */
function violationBanner(pending, enforced, action) {
  if (pending.length > 0) {
    const soonest = pending.reduce(
      (best, entry) => (!best || new Date(entry.enforceAt) < new Date(best.enforceAt) ? entry : best),
      null,
    );
    const when = humaniseCountdown(new Date(), soonest.enforceAt);
    const verb = action === ACTION.FLAG ? 'flagged for review' : 'removed';

    return el('div', { class: 'wrm-banner wrm-banner--amber' }, [
      el('div', { class: 'wrm-banner__title' }, ['⚠', ' Violation Detected']),
      el('div', {
        text:
          `Enforcement begins ${when}. The worklog will be ${verb} automatically once the ` +
          'grace period expires.',
      }),
      transitionDetail(soonest),
      el('p', {
        class: 'wrm-footnote',
        text: `Counted from when the worklog breached the policy (${formatDate(soonest.violationSince)}), not from when this app first saw it.`,
      }),
    ]);
  }

  const first = enforced[0];
  const verb = action === ACTION.FLAG ? 'flagged for manual review' : 'automatically removed';

  return el('div', { class: 'wrm-banner wrm-banner--red' }, [
    el('div', { class: 'wrm-banner__title' }, ['⚠', ' Violation Detected']),
    el('div', {
      text: `A worklog was added for a restricted historical period and has been ${verb}.`,
    }),
    first
      ? el('div', {
          class: 'wrm-banner__meta',
          text: `${formatDate(first.started)} · ${first.authorDisplayName} · ${first.timeSpent ?? ''}`.trim(),
        })
      : null,
    transitionDetail(first),
  ]);
}

/** Extra context that only the "After Status Transition" rule produces. */
function transitionDetail(entry) {
  const detail = entry?.detail;
  if (!detail?.targetStatusName) return null;
  return el('div', {
    class: 'wrm-banner__meta',
    text: `Restricted after transition to “${detail.targetStatusName}” on ${formatDate(detail.transitionedAt)}.`,
  });
}

function worklogTable(worklogs, action) {
  return el('div', { class: 'wrm-card' }, [
    el('table', { class: 'wrm-table' }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Date' }),
          el('th', { text: 'Author' }),
          el('th', { text: 'Time spent' }),
          el('th', { text: 'Status' }),
        ]),
      ]),
      el(
        'tbody',
        {},
        worklogs.map((entry) =>
          el('tr', { class: entry.state === STATE.COMPLIANT ? null : 'wrm-row--violation' }, [
            el('td', { text: formatDate(entry.started) }),
            el('td', { text: entry.authorDisplayName }),
            el('td', { text: entry.timeSpent ?? '—' }),
            el('td', {}, [stateBadge(entry, action)]),
          ]),
        ),
      ),
    ]),
  ]);
}

function errorState(message) {
  return el('div', { class: 'wrm-banner wrm-banner--grey' }, [
    el('div', { text: message }),
  ]);
}

async function load() {
  try {
    const result = await invoke('validateIssue');
    clear(root);

    if (!result.active) {
      root.append(notActive());
      resize();
      return;
    }

    const worklogs = result.worklogs ?? [];
    const violations = worklogs.filter((entry) => entry.state !== STATE.COMPLIANT);
    const pending = violations.filter((entry) => entry.state === STATE.GRACE);
    const acted = violations.filter((entry) => entry.state === STATE.ENFORCE);

    if (violations.length === 0) {
      root.append(compliant(worklogs.length));
      if (worklogs.length > 0) root.append(worklogTable(worklogs, result.action));
      resize();
      return;
    }

    root.append(violationBanner(pending, acted, result.action));
    if (worklogs.length > 0) root.append(worklogTable(worklogs, result.action));
    resize();
  } catch (error) {
    clear(root);
    root.append(
      errorState(
        error?.message ?? 'Worklog compliance could not be checked right now. Please reload the issue.',
      ),
    );
    resize();
  }
}

/** Keep the iframe tall enough for the table without an inner scrollbar. */
function resize() {
  view.resize?.();
}

load();
