import api, { route } from '@forge/api';
import { dedupeStatuses } from '../shared/rules.mjs';

/**
 * Thin wrappers over the Jira REST v3 endpoints this app needs.
 *
 * All calls go through `route` so path segments are escaped, and every failure
 * is converted into a message that is safe to show an admin.
 */

class JiraError extends Error {
  constructor(message, { status, endpoint } = {}) {
    super(message);
    this.name = 'JiraError';
    this.status = status;
    this.endpoint = endpoint;
  }
}

/** Turns a non-2xx response into something an admin can act on. */
async function fail(response, endpoint, friendly) {
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 400);
  } catch {
    /* body already consumed or empty */
  }

  console.error(`Jira ${response.status} on ${endpoint}: ${detail}`);

  if (response.status === 429) {
    throw new JiraError('Jira is rate limiting requests. Please retry in a moment.', {
      status: 429,
      endpoint,
    });
  }
  if (response.status === 401 || response.status === 403) {
    throw new JiraError(`${friendly} The app may be missing a required permission.`, {
      status: response.status,
      endpoint,
    });
  }
  throw new JiraError(friendly, { status: response.status, endpoint });
}

const asApp = () => api.asApp();

/* --------------------------------------------------------------- admin gate -- */

/**
 * Whether the given user holds the ADMINISTER (Jira admin) global permission.
 *
 * The app spec assumed the frontend could read an `isAdmin` flag off the Jira
 * context. No such flag exists, and Forge documents that context values are not
 * guaranteed "secure, unalterable, and valid to be used for authorization" — so
 * the gate lives here, where a directly-invoked resolver cannot bypass it.
 *
 * Uses the bulk permission check as the app: Atlassian documents that apps may
 * ask about any user without needing admin rights themselves, which avoids the
 * asUser() failures seen for unlicensed and customer accounts.
 *
 * Fails closed — anything unexpected means "not an admin".
 */
export async function isJiraAdmin(accountId) {
  if (!accountId) return false;

  const endpoint = '/rest/api/3/permissions/check';
  try {
    const response = await asApp().requestJira(route`/rest/api/3/permissions/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ accountId, globalPermissions: ['ADMINISTER'] }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error(`Admin check failed (${response.status}) on ${endpoint}: ${detail.slice(0, 300)}`);
      return false;
    }

    const body = await response.json();
    return Array.isArray(body?.globalPermissions) && body.globalPermissions.includes('ADMINISTER');
  } catch (error) {
    console.error(`Admin check threw: ${error.message}`);
    return false;
  }
}

/* ---------------------------------------------------------------- statuses -- */

/**
 * Global statuses for the transition dropdown.
 *
 * /rest/api/3/status takes no parameters and is not paginated. It returns one
 * row per workflow, so names repeat — deduped here because this app matches
 * changelog entries by status *name*.
 */
export async function fetchStatuses() {
  const endpoint = '/rest/api/3/status';
  const response = await asApp().requestJira(route`/rest/api/3/status`, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    await fail(response, endpoint, 'Could not load statuses — please retry.');
  }

  const body = await response.json();
  return dedupeStatuses(Array.isArray(body) ? body : []);
}

/* ---------------------------------------------------------------- projects -- */

/** Every project on the site. maxResults is capped at 100, so this pages. */
export async function fetchProjects() {
  const endpoint = '/rest/api/3/project/search';
  const projects = [];
  let startAt = 0;

  // Hard stop so a misbehaving response cannot spin forever.
  for (let page = 0; page < 100; page += 1) {
    const response = await asApp().requestJira(
      route`/rest/api/3/project/search?startAt=${String(startAt)}&maxResults=100&orderBy=name`,
      { headers: { Accept: 'application/json' } },
    );

    if (!response.ok) await fail(response, endpoint, 'Could not load projects.');

    const body = await response.json();
    for (const project of body.values ?? []) {
      projects.push({
        id: String(project.id),
        key: project.key,
        name: project.name,
        // 24px renders crisply at the 20px the table draws it at.
        avatarUrl: project.avatarUrls?.['24x24'] ?? project.avatarUrls?.['32x32'] ?? null,
      });
    }

    if (body.isLast || !body.values?.length) break;
    startAt += body.values.length;
  }

  return projects;
}

/* ------------------------------------------------------------------- issue -- */

/**
 * Resolves an issue id or key to the fields this app needs.
 *
 * The worklog event payload carries only `issueId`, with no issue key and no
 * project, so the trigger has to make this call before it can apply the
 * project gate.
 */
export async function fetchIssueContext(issueIdOrKey) {
  const endpoint = `/rest/api/3/issue/${issueIdOrKey}`;
  const response = await asApp().requestJira(
    route`/rest/api/3/issue/${issueIdOrKey}?fields=project,summary`,
    { headers: { Accept: 'application/json' } },
  );

  if (!response.ok) await fail(response, endpoint, 'Could not load the issue.');

  const body = await response.json();
  return {
    id: String(body.id),
    key: body.key,
    summary: body.fields?.summary ?? '',
    projectKey: body.fields?.project?.key ?? null,
    projectName: body.fields?.project?.name ?? '',
  };
}

/* ---------------------------------------------------------------- worklogs -- */

/** All worklogs on an issue, paged defensively. */
export async function fetchWorklogs(issueIdOrKey) {
  const endpoint = `/rest/api/3/issue/${issueIdOrKey}/worklog`;
  const worklogs = [];
  let startAt = 0;

  for (let page = 0; page < 50; page += 1) {
    const response = await asApp().requestJira(
      route`/rest/api/3/issue/${issueIdOrKey}/worklog?startAt=${String(startAt)}&maxResults=1000`,
      { headers: { Accept: 'application/json' } },
    );

    if (!response.ok) await fail(response, endpoint, 'Could not load worklogs for this issue.');

    const body = await response.json();
    const batch = body.worklogs ?? [];
    for (const worklog of batch) {
      worklogs.push({
        id: String(worklog.id),
        started: worklog.started,
        // When the worklog was logged, as opposed to the time it claims to
        // cover. Dates the breach in "After Status Transition" mode.
        created: worklog.created,
        timeSpent: worklog.timeSpent,
        timeSpentSeconds: worklog.timeSpentSeconds,
        authorAccountId: worklog.author?.accountId ?? null,
        authorDisplayName: worklog.author?.displayName ?? null,
      });
    }

    startAt += batch.length;
    if (batch.length === 0 || startAt >= (body.total ?? startAt)) break;
  }

  return worklogs;
}

/**
 * Deletes a worklog as the app.
 *
 * asApp() because enforcement has no invoking user in the trigger path, and
 * because acting as the author would be bounded by that author's own
 * permissions and would look like the author deleted their own entry.
 *
 * notifyUsers=false — the app posts its own comment; Jira's default deletion
 * mail on top of that is noise.
 */
export async function deleteWorklog(issueIdOrKey, worklogId) {
  const endpoint = `/rest/api/3/issue/${issueIdOrKey}/worklog/${worklogId}`;
  const response = await asApp().requestJira(
    route`/rest/api/3/issue/${issueIdOrKey}/worklog/${worklogId}?notifyUsers=false&adjustEstimate=auto&overrideEditableFlag=true`,
    { method: 'DELETE' },
  );

  // Already gone: treat as success so enforcement is idempotent.
  if (response.status === 404) return { deleted: false, alreadyGone: true };

  if (!response.ok) {
    await fail(response, endpoint, 'Could not delete the worklog.');
  }

  return { deleted: true, alreadyGone: false };
}

/* ---------------------------------------------------------------- comments -- */

/**
 * Posts the system notification.
 *
 * Takes a prebuilt ADF document so the author can be a real mention node —
 * that is what makes Jira send them an email. Note that Jira Software has no
 * internal comments, so this is visible to anyone who can browse the issue.
 */
export async function postComment(issueIdOrKey, document) {
  const endpoint = `/rest/api/3/issue/${issueIdOrKey}/comment`;
  const response = await asApp().requestJira(
    route`/rest/api/3/issue/${issueIdOrKey}/comment`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ body: document }),
    },
  );

  if (!response.ok) {
    await fail(response, endpoint, 'Could not post the system comment.');
  }

  return true;
}

/* --------------------------------------------------------------- changelog -- */

/**
 * Status-field history for an issue, oldest-first.
 *
 * Uses the dedicated paginated endpoint rather than `expand=changelog`, which
 * is newest-first and unpaginated.
 */
export async function fetchStatusChangelog(issueIdOrKey) {
  const endpoint = `/rest/api/3/issue/${issueIdOrKey}/changelog`;
  const entries = [];
  let startAt = 0;

  for (let page = 0; page < 50; page += 1) {
    const response = await asApp().requestJira(
      route`/rest/api/3/issue/${issueIdOrKey}/changelog?startAt=${String(startAt)}&maxResults=100`,
      { headers: { Accept: 'application/json' } },
    );

    if (!response.ok) await fail(response, endpoint, 'Could not load the issue history.');

    const body = await response.json();
    const batch = body.values ?? [];

    for (const entry of batch) {
      const items = (entry.items ?? []).filter(
        (item) => String(item.field ?? '').toLowerCase() === 'status',
      );
      if (items.length > 0) {
        entries.push({
          created: entry.created,
          items: items.map((item) => ({
            field: 'status',
            fromString: item.fromString,
            toString: item.toString,
          })),
        });
      }
    }

    startAt += batch.length;
    if (batch.length === 0 || body.isLast || startAt >= (body.total ?? startAt)) break;
  }

  return entries;
}

/* ------------------------------------------------------- restore worklogs -- */

/**
 * Re-creates a previously deleted worklog.
 *
 * Jira takes the author from the authenticated caller: `author` is readOnly on
 * the Worklog schema, and an `authorAccountId` in the body is silently ignored.
 * So the only way to restore something under its original author is to
 * impersonate them via asUser(accountId), which needs allowImpersonation on the
 * scopes — and which Atlassian refuses for any user lacking access to the app.
 *
 * Because a silently-ignored author is indistinguishable from success, the
 * caller gets back the account id Jira actually recorded, read off the 201.
 *
 * @param {object}  args
 * @param {string}  args.issueKey
 * @param {string}  args.startedIso         Already in Jira's +0000 format.
 * @param {number}  args.timeSpentSeconds
 * @param {string}  [args.accountId]        Impersonate this author.
 * @param {boolean} [args.allowAppFallback] Post as the app if impersonation fails.
 * @returns {Promise<{ok: boolean, attributedTo: string, authorAccountId: string|null, error?: string}>}
 */
export async function restoreWorklog({
  issueKey,
  startedIso,
  timeSpentSeconds,
  accountId,
  allowAppFallback = false,
}) {
  // adjustEstimate=leave: a repair must not re-decrement the remaining
  // estimate, which the endpoint's default (auto) would silently do.
  // notifyUsers=false: nobody needs 144 emails about a cleanup.
  const path = route`/rest/api/3/issue/${issueKey}/worklog?notifyUsers=false&adjustEstimate=leave`;
  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ started: startedIso, timeSpentSeconds }),
  };

  const attempt = async (client, label) => {
    const response = await client.requestJira(path, options);

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // A malformed `started` surfaces here as a 500 with no body rather than
      // the documented 400, so name that instead of calling it transient.
      const hint =
        response.status === 500
          ? ' (a 500 on this endpoint usually means a malformed started date, not a server fault)'
          : '';
      return {
        ok: false,
        attributedTo: label,
        authorAccountId: null,
        error: `${response.status} ${detail.slice(0, 200)}${hint}`,
      };
    }

    const created = await response.json().catch(() => null);
    return {
      ok: true,
      attributedTo: label,
      // Read back what Jira recorded rather than trusting what we asked for.
      authorAccountId: created?.author?.accountId ?? null,
    };
  };

  if (accountId) {
    const impersonated = await attempt(api.asUser(accountId), 'author');
    if (impersonated.ok) return impersonated;

    console.error(`Impersonated restore failed for ${issueKey}: ${impersonated.error}`);
    if (!allowAppFallback) return impersonated;
  }

  return attempt(asApp(), 'app');
}

export { JiraError };
