// Filtering for the audit tables. Pure and dependency-free, so the same
// predicate drives the table, the row count, and the Excel export — a filtered
// export that disagreed with the screen would be worse than no filter at all.

/**
 * `2026-08` from any date-ish value, or '' when it cannot be read.
 *
 * UTC, like every other boundary in this app. A worklog dated 1 Aug 00:30 IST
 * is 31 Jul in UTC and will group under July; that is consistent with how the
 * rules themselves decide which month it belongs to.
 */
export function monthKey(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** `2026-08` -> `August 2026`. */
export function monthLabel(key) {
  const [year, month] = String(key ?? '').split('-').map(Number);
  if (!year || !month) return '';
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Stable identity for a person.
 *
 * Account id where available, because display names are not unique and change
 * when someone is renamed. Falls back to the name for entries written before
 * the account id was captured — those exist in the production log.
 */
export function authorKey(entry) {
  if (entry?.authorAccountId) return `id:${entry.authorAccountId}`;
  const name = entry?.authorDisplayName;
  return name ? `name:${name}` : '';
}

/**
 * Month options present in the data, newest first.
 *
 * Derived from the FULL dataset, never the already-filtered one — otherwise
 * choosing a month would empty the author list and strand the user with no way
 * back except a reload.
 */
export function monthOptions(entries = [], dateField) {
  const keys = new Set();
  for (const entry of entries) {
    const key = monthKey(entry?.[dateField]);
    if (key) keys.add(key);
  }
  return [...keys]
    .sort((a, b) => b.localeCompare(a))
    .map((value) => ({ value, label: monthLabel(value) }));
}

/**
 * Author options present in the data, alphabetical.
 *
 * Two people can genuinely share a display name in Jira, and they are separate
 * rows here because their account ids differ. Identical labels would make the
 * dropdown a coin toss, so colliding names get a short id fragment appended.
 */
export function authorOptions(entries = []) {
  const seen = new Map();
  for (const entry of entries) {
    const key = authorKey(entry);
    if (!key || seen.has(key)) continue;
    seen.set(key, entry.authorDisplayName || 'Unknown');
  }

  const counts = new Map();
  for (const label of seen.values()) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  return [...seen.entries()]
    .map(([value, label]) => ({
      value,
      label: counts.get(label) > 1 ? `${label} (…${value.slice(-4)})` : label,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Applies the active filters. An empty filter value means "no restriction",
 * so the default state returns everything untouched.
 */
export function applyFilters(entries = [], filters = {}, { dateField } = {}) {
  const month = filters.month || '';
  const author = filters.author || '';
  if (!month && !author) return [...entries];

  return entries.filter((entry) => {
    if (month && monthKey(entry?.[dateField]) !== month) return false;
    if (author && authorKey(entry) !== author) return false;
    return true;
  });
}

export function hasActiveFilters(filters = {}) {
  return Boolean(filters.month || filters.author);
}

/**
 * Human phrase for what the filters currently select, for confirm dialogs and
 * export filenames. A bulk action must be able to say what it is about to act
 * on, not just how many rows.
 */
export function describeFilters(filters = {}, entries = []) {
  if (!hasActiveFilters(filters)) return 'all entries';

  const parts = [];
  if (filters.month) parts.push(monthLabel(filters.month));
  if (filters.author) {
    const match = entries.find((entry) => authorKey(entry) === filters.author);
    parts.push(match?.authorDisplayName || 'the selected user');
  }
  return parts.join(', ');
}

/** Filename-safe suffix, e.g. `-2026-08-sagar`. Empty when nothing is filtered. */
export function filterFileSuffix(filters = {}, entries = []) {
  if (!hasActiveFilters(filters)) return '';

  const parts = [];
  if (filters.month) parts.push(filters.month);
  if (filters.author) {
    const match = entries.find((entry) => authorKey(entry) === filters.author);
    const name = (match?.authorDisplayName || 'user')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24);
    if (name) parts.push(name);
  }
  return parts.length ? `-${parts.join('-')}` : '';
}
