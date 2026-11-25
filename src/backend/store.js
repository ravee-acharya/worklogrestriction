import { kvs } from '@forge/kvs';
import { normaliseConfig } from '../shared/rules.mjs';

/**
 * KVS layout.
 *
 * The original app kept settings, the audit log and the review queue inside one
 * `worklogConfig` object. A KVS value is capped at 240 KiB, so an append-only
 * log sharing that key eventually makes the whole object unwritable — and the
 * first thing to break is the admin's ability to change or disable the rules.
 * Each concern gets its own key here, and the log is explicitly bounded.
 */
export const KEY = {
  CONFIG: 'config',
  REMOVAL_LOG: 'removalLog',
  PENDING_REVIEW: 'pendingReview',
};

/**
 * Entry ceilings. A KVS value is 240 KiB; an entry serialises to roughly
 * 250 bytes, so these leave a wide margin while keeping writes safe.
 */
export const MAX_REMOVAL_LOG_ENTRIES = 600;
export const MAX_PENDING_REVIEW_ENTRIES = 600;

/* ------------------------------------------------------------------ config -- */

export async function readConfig() {
  const stored = await kvs.get(KEY.CONFIG);
  return normaliseConfig(stored);
}

export async function writeConfig(config) {
  const normalised = normaliseConfig(config);
  await kvs.set(KEY.CONFIG, normalised);
  return normalised;
}

/* -------------------------------------------------------------- audit log -- */

/** @returns {{entries: Array, dropped: number}} */
export async function readRemovalLog() {
  const stored = await kvs.get(KEY.REMOVAL_LOG);
  if (Array.isArray(stored)) return { entries: stored, dropped: 0 };
  return { entries: stored?.entries ?? [], dropped: stored?.dropped ?? 0 };
}

export async function readPendingReview() {
  const stored = await kvs.get(KEY.PENDING_REVIEW);
  return Array.isArray(stored) ? stored : (stored?.entries ?? []);
}

/**
 * Appends audit entries, oldest-first, discarding the oldest beyond the cap.
 *
 * Read-modify-write inside one invocation. KVS has no compare-and-set, so a
 * panel enforcement and a trigger enforcement firing in the same instant can
 * still lose one entry — the narrowest window available without a lock.
 */
export async function appendRemovalLog(newEntries) {
  if (newEntries.length === 0) return;

  const { entries, dropped } = await readRemovalLog();
  const combined = [...entries, ...newEntries];
  const overflow = Math.max(0, combined.length - MAX_REMOVAL_LOG_ENTRIES);

  await kvs.set(KEY.REMOVAL_LOG, {
    entries: overflow > 0 ? combined.slice(overflow) : combined,
    dropped: dropped + overflow,
  });
}

export async function appendPendingReview(newEntries) {
  if (newEntries.length === 0) return;

  const entries = await readPendingReview();
  const seen = new Set(entries.map((entry) => entry.id));
  const additions = newEntries.filter((entry) => !seen.has(entry.id));
  if (additions.length === 0) return;

  const combined = [...entries, ...additions];
  const overflow = Math.max(0, combined.length - MAX_PENDING_REVIEW_ENTRIES);
  await kvs.set(KEY.PENDING_REVIEW, overflow > 0 ? combined.slice(overflow) : combined);
}

export async function removePendingReview(entryId) {
  const entries = await readPendingReview();
  const remaining = entries.filter((entry) => entry.id !== entryId);
  await kvs.set(KEY.PENDING_REVIEW, remaining);
  return remaining;
}

/**
 * Clears many queue entries in one write.
 *
 * Unlike a bulk restore this touches nothing in Jira — the queue is the only
 * record, so the work is a single set() and needs no batching against the
 * function time limit. Reviewing is destructive in the sense that the entry is
 * gone afterwards, which is why the console offers an export first.
 */
export async function removePendingReviewMany(entryIds) {
  const ids = new Set((entryIds ?? []).map(String));
  if (ids.size === 0) return readPendingReview();

  const entries = await readPendingReview();
  const remaining = entries.filter((entry) => !ids.has(String(entry.id)));
  await kvs.set(KEY.PENDING_REVIEW, remaining);
  return remaining;
}

/**
 * Stamps removal-log entries as restored, so a restore is idempotent and the
 * console can show which deletions have been undone.
 *
 * @param {Map<string,string>} outcomes entry id -> ISO restore time
 */
export async function markRestoredOne(entryId, at) {
  const { entries, dropped } = await readRemovalLog();
  const next = entries.map((entry) =>
    entry.id === entryId ? { ...entry, restoredAt: at } : entry,
  );
  await kvs.set(KEY.REMOVAL_LOG, { entries: next, dropped });
}

export async function markRestored(outcomes) {
  if (outcomes.size === 0) return;

  const { entries, dropped } = await readRemovalLog();
  const next = entries.map((entry) =>
    outcomes.has(entry.id) ? { ...entry, restoredAt: outcomes.get(entry.id) } : entry,
  );
  await kvs.set(KEY.REMOVAL_LOG, { entries: next, dropped });
}

// There is deliberately no per-worklog "first detected" store any more. The
// enforcement deadline is a pure function of the worklog's own dates and the
// active rule (see `violationSince` in shared/rules.mjs), which makes it
// identical on every evaluation without persisting anything — and removes the
// read-modify-write race that a shared detections map would have had between
// the panel and the trigger.
