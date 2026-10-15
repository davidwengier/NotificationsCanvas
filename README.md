# GitHub notification triage

A personal Copilot canvas. Ask Copilot to open the notification triage panel.
Uses the current `gh` account on github.com; all GitHub calls are read-only.

## Setup

Put these files in a `notification-triage` folder in your Copilot user extensions
directory, then reload extensions. Sign in with `gh auth login` and ask Copilot
to open the GitHub notification triage canvas. Running the local tests requires
Node.js 24 or later for its built-in SQLite support.

The `artifacts` directory is created on first use and is excluded from Git.
It contains your inbox, preferences and activity history, not extension source.

## Behaviour

Refresh retrieves all pages of unread notifications. Once discovered, items
stay in this local inbox even after GitHub stops reporting them as unread;
their unread status is shown on the card and GitHub's unread count is still
reported separately. Needs me shows GitHub's
reason for each notification, not AI analysis. Issues and pull requests show a
status icon: green for open, purple for completed or merged, red for closed
unmerged pull requests, and grey for drafts or issues closed as not planned or
duplicate. Statuses and the latest activity are fetched with read-only GraphQL
queries in batches of up to 50 threads per repository. GraphQL payloads use
standard input to avoid Windows command-line limits. Issues and pull requests
in Needs me and Following show the latest timeline activity, cached until the
notification updates; the refresh icon can check again on demand. Subscription
and mention bookkeeping are ignored, matching the manual activity lookup. It reports
event type and author, never comment or review text. Opening a notification link
launches GitHub in the system's default browser. Group by repository can be
turned off for a flat newest-first list. When grouping is enabled, repositories
are alphabetical and items within each repository remain newest-first. Each tab
independently remembers both grouping and repository expansion in the local
account data. The active tab and search filter are saved there too. These choices
survive extension reloads, application restarts,
reboots and new canvas sessions, as well as actions and refreshes within a panel.
Filters apply to the current view. Archiving
displayed items requires confirmation and only affects local state; archived
items remain in GitHub and are available under Archived. Unrelated updates and
old notification reasons do not undo an archive; a new direct mention,
assignment or review request after the archive time brings it back. A new
comment or inline review comment on a PR also brings it back if you have
previously commented on or reviewed that PR.

The activity history records discovery, GitHub notification and timeline
summaries, observed unread/status changes, your local triage actions, and
automatic resurfacing decisions. GitHub event time and the time this panel
noticed the event are shown separately; comment and review text is never saved.

Follow-up snapshots and notes survive a thread leaving the unread inbox.
Snoozed threads return when due while the panel is open; a new thread update
clears snoozing. New direct attention after an archive is detected on refresh.
The open panel refreshes when it starts and every ten minutes. New mentions,
review requests and other direct notifications appear in Needs me, even for a
saved follow-up. There are no background alerts. Reading through GitHub itself
can still affect GitHub's read state.
Subscriptions, read state and GitHub's saved/done states are never changed.

Data lives in `artifacts\triage.sqlite` beside this file, with separate account
records. Existing `artifacts\<GitHub numeric account ID>.json` files are imported
once and left untouched as recovery backups. SQLite is private local data, not
encrypted, and should not be shared or committed. The database stores item
snapshots and a structured activity log; it does not store comment or review
bodies.

Run `node --test` from this directory for local checks.
