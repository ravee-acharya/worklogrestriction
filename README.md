# Worklog Restriction Manager

A Jira Cloud Forge app that enforces company time-logging policy by detecting —
and optionally removing — worklogs that fall outside an administrator-configured
restriction window.

This is a **clean-room rebuild** of the app of the same name that was generated
by the in-product AI Apps Builder. It reimplements the published specification
and fixes the ten defects found while reviewing the deployed version. The UI is
a deliberate visual match for the original so the swap is not disruptive.

> **It deploys as a new app with its own app id.** It does not upgrade the
> existing installation. Install it alongside the old one, confirm it behaves,
> then uninstall the old one. See "Cutover" below.

---

## Layout

```
manifest.yml              GENERATED per distribution (gitignored)
manifests/
  manifest.template.yml   Modules, resources, scopes — the single source
  variants.json           Which app it IS: marketplace vs internal
.github/workflows/
  deploy.yml              verify -> marketplace -> internal
src/
  index.js                Resolvers + the standalone trigger handler
  shared/rules.mjs        Pure domain logic (no Jira, no storage, no DOM)
  backend/
    jira.js               Jira REST wrappers, friendly error mapping
    store.js              KVS layout and bounded append helpers
    enforce.js            The single enforcement path
  frontend/
    dom.js                Small DOM helpers shared by both surfaces
    admin/main.js         Admin console (4 tabs)
    panel/main.js         Issue panel
    preview/bridge-mock.js  Fixtures for local preview only
static/
  admin/{index.html,styles.css}   Shipped as written; main.js is built
  panel/{index.html,styles.css}
test/                     151 unit tests over the domain logic
scripts/                  Build, preview copy, preview server
```

`shared/rules.mjs` is the only place the rules live, and both the resolvers and
the two frontends import it — the surfaces cannot drift apart on what counts as
a violation.

## Prerequisites

- Node.js 22+
- Forge CLI: `npm install -g @forge/cli`
- A Jira Cloud site where you are a Jira administrator

## Setup

```bash
npm install
npm test
npm run build
```

Then, once per machine:

```bash
forge login
```

`forge login` needs your Atlassian email and an API token from
<https://id.atlassian.com/manage-profile/security/api-tokens>. Only you can run
this step.

## Register and deploy

Each distribution needs its own app id in `manifests/variants.json`. Claim one:

```bash
forge register
```

Then deploy to the development environment first — never straight to production:

```bash
forge deploy -e development
forge install -e development --product jira --site your-site.atlassian.net
```

Verify against the checklist below, then promote:

```bash
forge deploy -e production
forge install -e production --product jira --site your-site.atlassian.net
```

`forge deploy` uploads code; `forge install` grants it to a site. A deploy alone
changes nothing about what is installed. When scopes change, an existing install
needs `forge install --upgrade` and an admin must re-consent.

Logs: `forge logs -e development` (the trigger only logs server-side).

## Local preview — no deploy needed

```bash
npm run preview
```

Serves both surfaces at <http://localhost:4599> against fixtures, with
`@forge/bridge` swapped for a mock:

- `/admin/` — the console, with 243 fixture projects and a populated audit log
- `/panel/?scenario=grace` — violation inside its grace window
- `/panel/?scenario=violation` — grace expired, worklog removed
- `/panel/?scenario=compliant` / `?scenario=disabled` / `?scenario=error`
- `/admin/?scenario=denied` — the non-admin state

Nothing in `preview/` is shipped; `manifest.yml` points at `static/`.

---

## What was fixed

Numbering follows the review of the deployed app.

| # | Defect | Fix |
|---|---|---|
| 1 | **Grace period reset on every check, so enforcement never fired.** A 51-day-old worklog reported "enforcement in 2 days" indefinitely. | The deadline is a pure function of the worklog and the rule (`violationSince`), derived from the worklog's own dates rather than from when the app looked at it. No state is persisted, so the answer is identical on every evaluation and a long-stale violation gets no fresh window. Covered by named regression tests. |
| 2 | **"Enable all" / "Disable all" ignored the search filter** — filtering to one project and pressing Disable all rewrote all 243. | Bulk actions apply to the filtered rows only; the buttons state their scope ("Disable all (7 shown)"); bulk *enable* requires confirmation naming the count and whether deletion is active. |
| 3 | **Invalid config saved as valid.** "After Status Transition" with no target status saved with a success message and looked armed. | `validateConfig` runs in the form, in `saveConfig`, and again in `evaluateIssue`. The save is blocked with an inline error, and an invalid config can never enforce. |
| 4 | **Config read once at mount, so saves did not propagate** — Validator Preview and the rules form showed stale values until a full reload. | `saveConfig`/`saveProjects` return the object actually written and the console re-seeds its state from that. |
| 5 | **Removal Log never recorded the author**, leaving every row blank and "Top author" permanently empty. | `authorAccountId` and `authorDisplayName` are captured from the worklog before deletion and written into the audit entry. |
| 6 | **Malformed mention** in posted comments — a literal `@` sitting beside a real mention, rendering `[System Notification] @ @Name …`. | `buildCommentDocument` emits exactly one ADF `mention` node and no stray sigil. The defect was the duplication, not the mention: the mention is what makes Jira email the author, which is the whole point of the notice. |
| 7 | **Comment publicly named the employee and their violation.** Internal comments do not exist in Jira Software, so the notice is visible to everyone with browse permission. | **Not fixed — it cannot be, on this platform.** The comment is deliberately still posted and still mentions the author, because an author who is never told is worse. See "Open decision". |
| 8 | **No pagination** — 243 rows rendered at once and the toolbar scrolled out of view. | 50 rows per page with a windowed pager, and a sticky toolbar so an active filter is always visible. |
| 9 | **Broken project avatars** (four 404s, no fallback). | `onerror` swaps in an initials tile. |
| 10 | **Duplicate status names** in the transition dropdown (`In progress` twice, `Done` twice, `To Do`/`To-Do`). | `dedupeStatuses` collapses by normalised name and matching is case-insensitive. |

### Also addressed

- **KVS headroom.** The original kept settings, the audit log and the review
  queue in one `worklogConfig` value. A KVS value caps at 240 KiB, so an
  append-only log in that object eventually makes the config itself unwritable —
  the first casualty being the admin's ability to turn the rules off. Each
  concern now has its own key, and the log is capped at 600 entries with a
  `dropped` counter.
- **Authorisation.** The spec assumed the frontend could read an `isAdmin` flag
  off the Jira context. No such flag exists, and Forge documents that context
  values are not safe to authorise on. Every admin resolver verifies the caller
  holds the `ADMINISTER` global permission server-side and fails closed.
- **Unsaved-change protection.** Switching tabs used to discard edits silently.
- **Dirty-state save buttons** on both tabs, instead of one always-enabled
  button whose first click gave no feedback.
- **Stat cards name their month** ("In August 2026"), so a log full of older
  entries beside a `0` no longer reads as broken.

## Open decision

**Bug #7 has no clean fix, and the current behaviour is a deliberate trade.**
Jira Software has no internal comments, so any notice on the issue is visible to
everyone who can browse it. There is no way to tell the author privately *and*
leave an audit trail on the issue.

The app mentions the author on purpose: the ADF `mention` node is what makes Jira
send the email, and an author whose time entry vanishes with no notification has
no way to know, let alone correct it. Silence is the worse failure.

The three options:

1. **Current behaviour** — comment on the issue, mentioning the author, so they
   are emailed.
2. Comment but do not name the author (drop `{{authorName}}` from the template —
   a console edit, no code change). Nobody is named publicly, and nobody is
   notified either.
3. Do not comment at all; the Removal Log becomes the only record. The author
   gets no signal whatsoever.

Flag-only mode softens this considerably: it posts the same notice without
touching the worklog, so the author can fix it themselves. In delete mode the
public comment is the price of the author finding out at all.

## Known limitations

- **KVS has no compare-and-set.** Read-modify-write happens inside a single
  invocation, which is the narrowest available window, but a panel enforcement
  and a trigger enforcement in the same instant can still lose one audit entry.
  The spec acknowledges this; it is inherent to the storage choice.
- **Month and year boundaries are evaluated in UTC.** A worklog logged within a
  few hours of a month boundary can classify differently from how it reads in a
  user's local timezone.
- **The trigger payload shape is not fully documented.** Atlassian publishes only
  `{ eventType, selfGenerated, worklog }` for `avi:jira:created:worklog` and does
  not document the inner worklog object. The handler reads
  `event.worklog.issueId` and logs the payload keys if that is missing, so the
  first real event will tell you immediately if it differs. Check
  `forge logs` after the first worklog is created.
- **Granular scopes are still marked Beta** by Atlassian. They are the
  recommended direction, and classic and granular scopes cannot be mixed.
- The panel is opt-in per issue (standard Forge behaviour) — each user adds
  "Worklog Validator" from the issue's apps menu. **The trigger is the reliable
  enforcement path**; treat the panel as a display.
- No automated pruning of the audit log beyond the 600-entry cap.

## Cutover

1. `forge deploy -e development` + install on a test site, or on your real site
   alongside the existing app.
2. **Set enforcement to "Flag only" and enable a single throwaway project
   first.** Confirm the Removal Log and panel behave before letting it delete
   anything.
3. Check `forge logs` after creating a worklog, to confirm the trigger payload
   parsed.
4. Reproduce the old grace-period bug: create a back-dated worklog, note the
   countdown, reload, and confirm the deadline does **not** move.
5. Switch to Delete mode, re-enable the projects you want, and only then
   uninstall the old app.

Enabling a project in Delete mode arms automatic, irreversible deletion of real
worklogs. The confirmation dialog exists for a reason.

## Verification status

- `npm test` — 31/31 passing, covering all four period rules, the transition lock
  and reopen reset, the grace-period regression, config validation, status
  deduping, comment rendering and the log statistics.
- `npm run build` — both bundles build clean.
- Both surfaces were driven in a browser against fixtures: every tab, the
  filtered bulk actions, the blocked invalid save, pagination, the avatar
  fallback, and all five panel states. Structure and computed styles were
  asserted programmatically; a side-by-side pixel comparison against the live
  app has **not** been done.
- **Nothing has been deployed or run against real Jira data.** No resolver, no
  Jira REST call and no trigger has executed against a live site.
