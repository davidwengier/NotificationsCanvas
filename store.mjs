import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import { bucket, classify, needsAttention, rulesVersion } from "./rules.mjs";

const execute = promisify(execFile);
const activityCacheVersion = 3;
const notificationsEndpoint = "notifications?all=true&per_page=100";
const bucketNames = { needs: "Needs me", following: "Following", followup: "Follow-up", snoozed: "Snoozed", filed: "Archived" };
// Filter before taking the latest event so subscription and mention bookkeeping
// cannot hide the discussion activity that caused the notification.
const issueActivityTypes = [
    "ISSUE_COMMENT", "ASSIGNED_EVENT", "UNASSIGNED_EVENT", "LABELED_EVENT", "UNLABELED_EVENT",
    "MILESTONED_EVENT", "DEMILESTONED_EVENT", "RENAMED_TITLE_EVENT", "LOCKED_EVENT",
    "UNLOCKED_EVENT", "CLOSED_EVENT", "REOPENED_EVENT",
];
const pullRequestActivityTypes = [
    ...issueActivityTypes, "PULL_REQUEST_REVIEW", "PULL_REQUEST_REVIEW_THREAD", "REVIEW_REQUESTED_EVENT",
    "MERGED_EVENT", "READY_FOR_REVIEW_EVENT", "CONVERT_TO_DRAFT_EVENT", "HEAD_REF_FORCE_PUSHED_EVENT",
];
const issueActivityFields = `
    __typename
    ... on IssueComment { createdAt author { login } }
    ... on AssignedEvent { createdAt actor { login } }
    ... on UnassignedEvent { createdAt actor { login } }
    ... on LabeledEvent { createdAt actor { login } label { name } }
    ... on UnlabeledEvent { createdAt actor { login } label { name } }
    ... on MilestonedEvent { createdAt actor { login } milestoneTitle }
    ... on DemilestonedEvent { createdAt actor { login } milestoneTitle }
    ... on RenamedTitleEvent { createdAt actor { login } currentTitle }
    ... on LockedEvent { createdAt actor { login } }
    ... on UnlockedEvent { createdAt actor { login } }
    ... on ClosedEvent { createdAt actor { login } }
    ... on ReopenedEvent { createdAt actor { login } }
`;
const pullRequestActivityFields = `
    ${issueActivityFields}
    ... on PullRequestReview { submittedAt author { login } state }
    ... on PullRequestReviewThread { comments(last: 1) { nodes { createdAt author { login } } } }
    ... on ReviewRequestedEvent { createdAt actor { login } }
    ... on MergedEvent { createdAt actor { login } }
    ... on ReadyForReviewEvent { createdAt actor { login } }
    ... on ConvertToDraftEvent { createdAt actor { login } }
    ... on HeadRefForcePushedEvent { createdAt actor { login } }
`;

async function github(endpoint, paginate = false) {
    const args = ["api", "--hostname", "github.com", "--method", "GET", endpoint];
    if (paginate) args.push("--paginate", "--slurp");
    const { stdout } = await execute("gh", args, { windowsHide: true, timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(stdout);
}

export async function githubGraphql(query, variables, executeCommand = execute) {
    // Activity batches exceed Windows' command-line limit; keep the payload on stdin.
    const command = executeCommand("gh", ["api", "graphql", "--hostname", "github.com", "--input", "-"],
        { windowsHide: true, timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
    const input = pipeline(Readable.from([JSON.stringify({ query, variables })]), command.child.stdin);
    const [result, written] = await Promise.allSettled([command, input]);
    // Report GitHub's error rather than a secondary broken pipe if it exits early.
    if (result.status === "rejected") throw result.reason;
    if (written.status === "rejected") throw written.reason;
    return JSON.parse(result.value.stdout);
}

function normalize(item) {
    const repo = item.repository?.full_name;
    const match = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(issues|pulls)\/(\d+)$/.exec(item.subject?.url ?? "");
    // Never open URLs supplied by notification titles or untrusted HTML.
    const url = match
        ? `https://github.com/${match[1]}/${match[2] === "pulls" ? "pull" : "issues"}/${match[3]}`
        : item.repository?.html_url;
    if (!item.id || !repo || !item.subject?.title || typeof item.reason !== "string" ||
        typeof item.unread !== "boolean" || !Number.isFinite(Date.parse(item.updated_at)) ||
        !url?.startsWith("https://github.com/")) {
        throw new Error("GitHub returned an unsupported notification shape; the previous snapshot has not been replaced.");
    }
    return {
        id: String(item.id), repo, title: item.subject.title, number: match?.[3] ?? null, reason: item.reason,
        type: item.subject.type, updatedAt: item.updated_at, url, inUnread: item.unread,
        githubUnread: item.unread, githubReason: item.reason, inGithubNotifications: true,
    };
}

export class TriageStore {
    constructor(directory, client = github, graphqlClient = githubGraphql) {
        this.directory = directory;
        this.client = client;
        this.graphqlClient = graphqlClient;
        this.databasePromise = null;
        this.teamMemberships = null;
        this.teamMembershipsLogin = null;
    }

    async close() {
        if (!this.databasePromise) return;
        const db = await this.databasePromise;
        db.close();
        this.databasePromise = null;
    }

    async database() {
        if (!this.databasePromise) {
            this.databasePromise = (async () => {
                await mkdir(this.directory, { recursive: true });
                const db = new DatabaseSync(join(this.directory, "triage.sqlite"));
                db.exec(`
                    PRAGMA journal_mode = WAL;
                    PRAGMA foreign_keys = ON;
                    PRAGMA busy_timeout = 5000;
                `);
                const version = db.prepare("PRAGMA user_version").get().user_version;
                if (version > 2) {
                    db.close();
                    throw new Error(`Triage database schema ${version} is newer than this extension supports.`);
                }
                db.exec(`
                    CREATE TABLE IF NOT EXISTS accounts (
                        account_id INTEGER PRIMARY KEY,
                        login TEXT NOT NULL,
                        unread_count INTEGER NOT NULL DEFAULT 0,
                        last_refresh TEXT,
                        view_preferences_json TEXT
                    );
                    CREATE TABLE IF NOT EXISTS items (
                        account_id INTEGER NOT NULL REFERENCES accounts(account_id),
                        id TEXT NOT NULL,
                        repo TEXT,
                        number TEXT,
                        ordinal INTEGER NOT NULL,
                        item_json TEXT NOT NULL,
                        PRIMARY KEY (account_id, id)
                    );
                    CREATE INDEX IF NOT EXISTS items_by_thread ON items(account_id, repo, number);
                    CREATE TABLE IF NOT EXISTS activity_log (
                        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                        account_id INTEGER NOT NULL REFERENCES accounts(account_id),
                        item_id TEXT NOT NULL,
                        repo TEXT NOT NULL,
                        number TEXT,
                        event_key TEXT NOT NULL,
                        event_type TEXT NOT NULL,
                        source TEXT NOT NULL,
                        actor TEXT,
                        occurred_at TEXT NOT NULL,
                        observed_at TEXT NOT NULL,
                        summary TEXT NOT NULL,
                        details_json TEXT,
                        UNIQUE (account_id, item_id, event_key)
                    );
                    CREATE INDEX IF NOT EXISTS activity_by_item
                        ON activity_log(account_id, item_id, occurred_at, sequence);
                    CREATE INDEX IF NOT EXISTS activity_by_thread
                        ON activity_log(account_id, repo, number, sequence);
                    CREATE TABLE IF NOT EXISTS refresh_runs (
                        id TEXT PRIMARY KEY,
                        account_id INTEGER,
                        started_at TEXT NOT NULL,
                        completed_at TEXT,
                        status TEXT NOT NULL,
                        stage TEXT NOT NULL,
                        endpoint TEXT NOT NULL,
                        page_count INTEGER,
                        notification_count INTEGER,
                        unread_count INTEGER,
                        rules_version INTEGER NOT NULL,
                        error TEXT
                    );
                    CREATE INDEX IF NOT EXISTS refresh_by_account
                        ON refresh_runs(account_id, started_at);
                    PRAGMA user_version = 2;
                `);
                return db;
            })();
        }
        try {
            return await this.databasePromise;
        } catch (error) {
            this.databasePromise = null;
            throw error;
        }
    }

    async account() {
        const user = await this.client("user");
        if (!Number.isSafeInteger(user.id) || !user.login) throw new Error("GitHub account identity is missing.");
        this.identity = { id: user.id, login: user.login };
        return this.identity;
    }

    async readLegacy(identity) {
        try {
            const state = JSON.parse(await readFile(join(this.directory, `${identity.id}.json`), "utf8"));
            if (state.version !== 1 || state.accountId !== identity.id || !Array.isArray(state.items)) {
                throw new Error("The saved triage data has an unsupported format.");
            }
            return state;
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            return { version: 1, accountId: identity.id, login: identity.login, lastRefresh: null, unreadCount: 0, items: [] };
        }
    }

    loadState(db, identity) {
        const account = db.prepare("SELECT * FROM accounts WHERE account_id = ?").get(identity.id);
        if (!account) return null;
        const state = {
            version: 1,
            accountId: identity.id,
            login: account.login,
            lastRefresh: account.last_refresh,
            unreadCount: account.unread_count,
            items: db.prepare("SELECT item_json FROM items WHERE account_id = ? ORDER BY ordinal, id")
                .all(identity.id).map(row => JSON.parse(row.item_json)),
        };
        if (account.view_preferences_json) state.viewPreferences = JSON.parse(account.view_preferences_json);
        return state;
    }

    saveState(db, identity, state) {
        db.prepare(`
            INSERT INTO accounts (account_id, login, unread_count, last_refresh, view_preferences_json)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(account_id) DO UPDATE SET
                login = excluded.login,
                unread_count = excluded.unread_count,
                last_refresh = excluded.last_refresh,
                view_preferences_json = excluded.view_preferences_json
        `).run(identity.id, state.login ?? identity.login, state.unreadCount ?? 0, state.lastRefresh ?? null,
            state.viewPreferences ? JSON.stringify(state.viewPreferences) : null);
        const saveItem = db.prepare(`
            INSERT INTO items (account_id, id, repo, number, ordinal, item_json)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(account_id, id) DO UPDATE SET
                repo = excluded.repo,
                number = excluded.number,
                ordinal = excluded.ordinal,
                item_json = excluded.item_json
        `);
        db.prepare("DELETE FROM items WHERE account_id = ?").run(identity.id);
        state.items.forEach((item, ordinal) => {
            saveItem.run(identity.id, item.id, item.repo ?? null, item.number ?? null, ordinal, JSON.stringify(item));
        });
        for (const event of state.activityEvents ?? []) {
            db.prepare(`
                INSERT OR IGNORE INTO activity_log
                    (account_id, item_id, repo, number, event_key, event_type, source, actor,
                     occurred_at, observed_at, summary, details_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(identity.id, event.itemId, event.repo, event.number ?? null, event.eventKey,
                event.eventType, event.source, event.actor ?? null, event.occurredAt, event.observedAt,
                event.summary, event.details ? JSON.stringify(event.details) : null);
        }
        delete state.activityEvents;
    }

    logActivity(state, item, event) {
        state.activityEvents ??= [];
        const occurredAt = event.occurredAt ?? new Date().toISOString();
        state.activityEvents.push({
            itemId: item.id,
            repo: item.repo,
            number: item.number,
            eventKey: event.eventKey ?? randomUUID(),
            eventType: event.eventType,
            source: event.source,
            actor: event.actor ?? null,
            occurredAt,
            observedAt: event.observedAt ?? new Date().toISOString(),
            summary: event.summary,
            details: event.details ?? null,
        });
    }

    logDecision(state, item, previous, { trigger, refreshId = null, observedAt = new Date().toISOString() }) {
        const decision = classify(item, Date.parse(observedAt));
        const previousBucket = previous ? bucket(previous, Date.parse(observedAt)) : null;
        const showInHistory = !previous || trigger !== "refresh" || previousBucket !== decision.bucket ||
            previous.updatedAt !== item.updatedAt || previous.reason !== item.reason ||
            previous.status !== item.status || previous.githubUnread !== item.githubUnread ||
            previous.inGithubNotifications !== item.inGithubNotifications;
        const readState = item.githubUnread === false ? " GitHub reported it as read." : "";
        this.logActivity(state, item, {
            eventType: "triage_decision",
            source: "local_rule",
            occurredAt: observedAt,
            observedAt,
            summary: `${bucketNames[decision.bucket]}: ${decision.explanation}${readState}`,
            details: {
                refreshId, trigger, rulesVersion, ...decision, previousBucket, showInHistory,
                inputs: {
                    reason: item.reason, githubReason: item.githubReason ?? null,
                    githubUnread: item.githubUnread ?? null, returnedByGithub: item.inGithubNotifications ?? null,
                    updatedAt: item.updatedAt, status: item.status ?? null, prState: item.prState ?? null,
                    authorLogin: item.authorLogin ?? null, saved: item.saved ?? false,
                    filed: item.filed ?? false, filedAt: item.filedAt ?? null,
                    snoozedUntil: item.snoozedUntil ?? null, recentActivity: item.recentActivity ?? null,
                    recentActivityOccurredAt: item.recentActivityOccurredAt ?? null,
                },
            },
        });
    }

    saveRefreshRun(db, run) {
        db.prepare(`
            INSERT INTO refresh_runs
                (id, account_id, started_at, completed_at, status, stage, endpoint,
                 page_count, notification_count, unread_count, rules_version, error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                account_id = excluded.account_id, completed_at = excluded.completed_at,
                status = excluded.status, stage = excluded.stage, page_count = excluded.page_count,
                notification_count = excluded.notification_count, unread_count = excluded.unread_count,
                error = excluded.error
        `).run(run.id, run.accountId ?? null, run.startedAt, run.completedAt ?? null,
            run.status, run.stage, run.endpoint, run.pageCount ?? null, run.notificationCount ?? null,
            run.unreadCount ?? null, rulesVersion, run.error ?? null);
    }

    async diagnose(repo, number, beforeSequence = null) {
        if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
            !Number.isSafeInteger(Number(number)) || Number(number) < 1 ||
            (beforeSequence !== null && (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1))) {
            throw new Error("A repository and a positive issue or PR number are required.");
        }
        const identity = this.identity ?? await this.account();
        const state = await this.read(identity);
        const db = await this.database();
        const items = state.items.filter(item => item.repo === repo && item.number === String(number));
        const rows = db.prepare(`
            SELECT sequence, item_id AS itemId, event_type AS eventType, source, actor,
                   occurred_at AS occurredAt, observed_at AS observedAt, summary, details_json AS detailsJson
            FROM activity_log WHERE account_id = ? AND repo = ? AND number = ?
                AND (? IS NULL OR sequence < ?)
            ORDER BY sequence DESC LIMIT 201
        `).all(identity.id, repo, String(number), beforeSequence, beforeSequence);
        const events = rows.slice(0, 200).map(({ detailsJson, ...event }) => ({
            ...event, details: detailsJson ? JSON.parse(detailsJson) : null,
        }));
        const runColumns = `
            SELECT id, account_id AS accountId, started_at AS startedAt, completed_at AS completedAt,
                   status, stage, endpoint, page_count AS pageCount, notification_count AS notificationCount,
                   unread_count AS unreadCount, rules_version AS rulesVersion, error
            FROM refresh_runs`;
        const runs = db.prepare(`${runColumns} WHERE account_id = ? OR account_id IS NULL
            ORDER BY started_at DESC, rowid DESC LIMIT 25
        `).all(identity.id);
        const refreshIds = [...new Set(events.map(event => event.details?.refreshId).filter(Boolean))];
        const relatedRuns = refreshIds.length ? db.prepare(`${runColumns}
            WHERE account_id = ? AND id IN (${refreshIds.map(() => "?").join(",")})
            ORDER BY started_at DESC, rowid DESC
        `).all(identity.id, ...refreshIds) : [];
        const auditStartedAt = db.prepare(`
            SELECT MIN(started_at) AS startedAt FROM refresh_runs WHERE account_id = ? OR account_id IS NULL
        `).get(identity.id).startedAt;
        return {
            repo, number: String(number), rulesVersion,
            items: items.map(({ note, ...item }) => ({ ...item, classification: classify(item) })),
            events, recentRefreshes: runs, relatedRefreshes: relatedRuns, auditStartedAt,
            hasMoreEvents: rows.length > 200,
            nextBeforeSequence: rows.length > 200 ? events.at(-1).sequence : null,
            coverage: "Polling only: a successful refresh records what GitHub returned, not proof it returned every event. Running attempts may have been interrupted. No history exists for gaps before auditing began.",
        };
    }

    async read(identity) {
        const db = await this.database();
        const state = this.loadState(db, identity);
        if (state) return state;
        // Import legacy JSON once; keep it untouched as a recovery backup.
        return this.transaction(identity, () => {});
    }

    async activity(id) {
        if (typeof id !== "string" || !id.length || id.length > 100) throw new Error("Invalid notification ID.");
        const identity = this.identity ?? await this.account();
        const state = await this.read(identity);
        const item = state.items.find(candidate => candidate.id === id);
        if (!item) throw new Error("This item is no longer in the local inbox.");
        const db = await this.database();
        return db.prepare(`
            SELECT event_type AS eventType, source, actor, occurred_at AS occurredAt,
                   observed_at AS observedAt, summary, details_json AS detailsJson
            FROM activity_log
            WHERE account_id = ? AND item_id = ?
                AND event_type NOT IN ('notification_observed', 'archive_attention_checked')
                AND (event_type != 'triage_decision' OR json_extract(details_json, '$.showInHistory') = 1)
            ORDER BY occurred_at, sequence
        `).all(identity.id, id).map(event => ({
            ...event,
            details: event.detailsJson ? JSON.parse(event.detailsJson) : null,
            detailsJson: undefined,
        }));
    }

    async snapshot() {
        const identity = this.identity ?? await this.account();
        return this.read(identity);
    }

    async explain(id) {
        if (typeof id !== "string" || !id.length || id.length > 100) throw new Error("Invalid notification ID.");
        const identity = this.identity ?? await this.account();
        const state = await this.read(identity);
        const item = state.items.find(candidate => candidate.id === id);
        if (!item) throw new Error("This notification is no longer in the inbox. Refresh the panel.");
        const match = /^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:pull|issues)\/(\d+)$/.exec(item.url);
        if (!match) throw new Error("GitHub did not provide a supported issue or pull request link.");

        // Notification reasons are broad; the timeline can identify matching
        // activity without downloading any comment or review text.
        const pages = await this.client(`repos/${item.repo}/issues/${match[1]}/timeline?per_page=100`, true);
        if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new Error("GitHub returned an unexpected timeline format.");
        const cutoff = Date.parse(item.updatedAt) + 2 * 60 * 1000;
        // Include issue-specific changes such as assignment as well as PR review events.
        const relevantEvents = new Set(["reviewed", "commented", "review_comment", "review_requested", "assigned", "unassigned", "labeled", "unlabeled", "milestoned", "demilestoned", "renamed", "locked", "unlocked", "closed", "reopened", "merged", "ready_for_review", "converted_to_draft", "head_ref_force_pushed"]);
        const event = pages.flat()
            .filter(candidate => relevantEvents.has(candidate.event))
            .map(candidate => ({ candidate, at: Date.parse(candidate.submitted_at ?? candidate.created_at) }))
            .filter(entry => Number.isFinite(entry.at) && entry.at <= cutoff)
            .sort((a, b) => b.at - a.at)[0]?.candidate;

        if (!event) return { summary: "GitHub says this thread was updated, but there is no matching recent event in its timeline." };
        const actor = event.user?.login ?? event.actor?.login ?? event.review?.user?.login;
        const by = actor ? ` by ${actor}` : "";
        if (event.event === "reviewed") {
            if (event.state === "approved") return { summary: `Approved${by}.` };
            if (event.state === "changes_requested") return { summary: `Changes requested${by}.` };
            if (event.state === "dismissed") return { summary: `Review dismissed${by}.` };
            return { summary: `Review submitted${by}.` };
        }
        if (event.event === "commented" || event.event === "review_comment") return { summary: `${event.event === "review_comment" ? "Inline review comment" : "Comment"} added${by}.` };
        if (event.event === "review_requested") return { summary: `Review requested${by}.` };
        if (event.event === "assigned") return { summary: event.assignee?.login ? `Assigned to ${event.assignee.login}${by}.` : `Assignee added${by}.` };
        if (event.event === "unassigned") return { summary: event.assignee?.login ? `${event.assignee.login} unassigned${by}.` : `Assignee removed${by}.` };
        if (event.event === "labeled") return { summary: `Label added${by}.` };
        if (event.event === "unlabeled") return { summary: `Label removed${by}.` };
        if (event.event === "milestoned") return { summary: `Added to a milestone${by}.` };
        if (event.event === "demilestoned") return { summary: `Removed from a milestone${by}.` };
        if (event.event === "renamed") return { summary: `Thread title changed${by}.` };
        if (event.event === "locked") return { summary: `Thread locked${by}.` };
        if (event.event === "unlocked") return { summary: `Thread unlocked${by}.` };
        if (event.event === "closed" && event.commit_id) return { summary: `Pull request merged${by}.` };
        if (event.event === "closed") return { summary: `Thread closed${by}.` };
        if (event.event === "reopened") return { summary: `Thread reopened${by}.` };
        if (event.event === "merged") return { summary: `Pull request merged${by}.` };
        if (event.event === "ready_for_review") return { summary: `Marked ready for review${by}.` };
        if (event.event === "converted_to_draft") return { summary: `Converted to draft${by}.` };
        return { summary: `Pull request updated${by}.` };
    }

    async transaction(identity, update) {
        const db = await this.database();
        const legacy = this.loadState(db, identity) ? null : await this.readLegacy(identity);
        db.exec("BEGIN IMMEDIATE");
        try {
            const existing = this.loadState(db, identity);
            const state = existing ?? legacy;
            if (!existing) {
                const observedAt = new Date().toISOString();
                for (const item of state.items) {
                    this.logActivity(state, item, {
                        eventKey: `migration:${item.id}`,
                        eventType: "legacy_imported",
                        source: "local_migration",
                        occurredAt: observedAt,
                        observedAt,
                        summary: "Imported an existing local triage record.",
                        details: { sourceUpdatedAt: item.updatedAt ?? null },
                    });
                }
            }
            const result = update(state);
            if (result && typeof result.then === "function") {
                throw new Error("Triage database transactions must not perform asynchronous work.");
            }
            this.saveState(db, identity, state);
            db.exec("COMMIT");
            return state;
        } catch (error) {
            db.exec("ROLLBACK");
            throw error;
        }
    }

    async refresh() {
        const db = await this.database();
        const run = {
            id: randomUUID(), startedAt: new Date().toISOString(), status: "running",
            stage: "account", endpoint: notificationsEndpoint,
        };
        this.saveRefreshRun(db, run);
        try {
            const identity = await this.account();
            run.accountId = identity.id;
            return await this.refreshSnapshot(identity, db, run);
        } catch (error) {
            run.status = "failed";
            run.completedAt = new Date().toISOString();
            run.error = error.message;
            try {
                this.saveRefreshRun(db, run);
            } catch (auditError) {
                throw new AggregateError([error, auditError], `Refresh failed: ${error.message}. Saving its diagnostic record also failed: ${auditError.message}`);
            }
            throw error;
        }
    }

    async refreshSnapshot(identity, db, run) {
        const previousState = await this.read(identity);
        run.stage = "notifications";
        this.saveRefreshRun(db, run);
        // Read flags belong to GitHub, not this inbox. Fetch read notifications too
        // so another GitHub client cannot hide an update before our next poll.
        const pages = await this.client(run.endpoint, true);
        if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new Error("GitHub pagination returned an unexpected format.");
        run.stage = "normalization";
        run.pageCount = pages.length;
        run.notificationCount = pages.flat().length;
        this.saveRefreshRun(db, run);
        const notifications = new Map();
        let normalizationError;
        // Save minimal receipts before status/timeline lookups. Even a failed refresh
        // must leave evidence that GitHub returned an item we could not apply.
        await this.transaction(identity, state => {
            for (const [index, raw] of pages.flat().entries()) {
                const subjectUrl = typeof raw?.subject?.url === "string" ? raw.subject.url : "";
                const match = /\/(?:issues|pulls)\/(\d+)$/.exec(subjectUrl);
                const item = {
                    id: typeof raw?.id === "string" || typeof raw?.id === "number" ? String(raw.id) : `invalid:${index}`,
                    repo: typeof raw?.repository?.full_name === "string" ? raw.repository.full_name : "(unknown)",
                    number: match?.[1] ?? null,
                };
                let error;
                try {
                    const normalized = normalize(raw ?? {});
                    notifications.set(normalized.id, normalized);
                } catch (failure) {
                    error = failure;
                    normalizationError ??= failure;
                }
                const observedAt = new Date().toISOString();
                this.logActivity(state, item, {
                    eventKey: `receipt:${run.id}:${index}`,
                    eventType: error ? "notification_rejected" : "notification_observed",
                    source: "github_observation",
                    occurredAt: observedAt,
                    observedAt,
                    summary: error ? `GitHub returned an unsupported notification: ${error.message}` :
                        `GitHub returned this notification (${raw.unread ? "unread" : "read"}).`,
                    details: {
                        refreshId: run.id, endpoint: run.endpoint,
                        githubReason: typeof raw?.reason === "string" ? raw.reason : null,
                        githubUnread: typeof raw?.unread === "boolean" ? raw.unread : null,
                        updatedAt: typeof raw?.updated_at === "string" ? raw.updated_at : null,
                        lastReadAt: typeof raw?.last_read_at === "string" ? raw.last_read_at : null,
                    },
                });
            }
        });
        if (normalizationError) throw normalizationError;
        const received = [...notifications.values()];
        run.unreadCount = received.filter(item => item.inUnread).length;
        const receivedIds = new Set(notifications.keys());
        const retained = previousState.items.filter(item => !receivedIds.has(item.id));
        const previousItems = new Map(previousState.items.map(item => [item.id, item]));
        const activityIds = new Set(received
            .filter(item => ["Issue", "PullRequest"].includes(item.type) &&
                (previousItems.get(item.id)?.activityUpdatedAt !== item.updatedAt ||
                    previousItems.get(item.id)?.activityVersion !== activityCacheVersion))
            .map(item => item.id));
        run.stage = "statuses";
        this.saveRefreshRun(db, run);
        const statuses = await this.loadStatuses([...received, ...retained], activityIds);
        run.stage = "archive_attention";
        this.saveRefreshRun(db, run);
        const { surfaced: freshAttention, checks } = await this.findFreshAttention(received, previousItems, statuses, identity.login);
        const observedAt = new Date().toISOString();
        run.stage = "applying";
        this.saveRefreshRun(db, run);
        return this.transaction(identity, state => {
            for (const { item, archivedAt, evidence, reason } of checks) {
                this.logActivity(state, item, {
                    eventType: "archive_attention_checked", source: "local_rule",
                    occurredAt: observedAt, observedAt,
                    summary: reason ? `Archived activity qualified for ${reason.replaceAll("_", " ")}.` :
                        "No activity qualified to undo this archive.",
                    details: { refreshId: run.id, archivedAt, ...evidence },
                });
            }
            const existing = new Map(state.items.map(item => [item.id, item]));
            state.items = received.map(item => {
                const previous = existing.get(item.id);
                existing.delete(item.id);
                // New thread activity wakes a snooze; archives only lift for a fresh attention event.
                const newActivity = previous && (previous.updatedAt !== item.updatedAt ||
                    (previous.githubReason ?? previous.reason) !== item.reason);
                const resumed = freshAttention.get(item.id);
                const stillFiled = Boolean(previous?.filed) &&
                    !(resumed && (previous.filedAt ?? previous.updatedAt) === resumed.archivedAt);
                const latestActivity = statuses.get(item.id)?.recentActivity;
                const checkedActivity = activityIds.has(item.id);
                const activity = ["Issue", "PullRequest"].includes(item.type) ? {
                    recentActivity: checkedActivity ? latestActivity ?? "No timeline activity found." :
                        previous?.recentActivity ?? "No timeline activity found.",
                    activityUpdatedAt: checkedActivity ? item.updatedAt : previous?.activityUpdatedAt ?? null,
                    activityVersion: checkedActivity ? activityCacheVersion : previous?.activityVersion ?? null,
                    recentActivityOccurredAt: checkedActivity ? statuses.get(item.id)?.recentActivityOccurredAt ?? item.updatedAt :
                        previous?.recentActivityOccurredAt ?? null,
                } : {};
                const current = {
                    ...item, ...statuses.get(item.id),
                    // Keep a local attention reason when GitHub repeats the same
                    // notification; a second poll must not undo a resurfacing.
                    reason: stillFiled ? item.reason : resumed?.reason ??
                        (previous?.githubReason === item.reason ? previous.reason : item.reason),
                    ...activity,
                    saved: previous?.saved ?? false, note: previous?.note ?? "",
                    snoozedUntil: newActivity ? null : previous?.snoozedUntil ?? null,
                    filed: stillFiled,
                    filedAt: stillFiled ? previous.filedAt ?? previous.updatedAt : null,
                };
                if (!previous) {
                    this.logActivity(state, current, {
                        eventKey: `discovered:${item.id}:${item.updatedAt}`,
                        eventType: "discovered",
                        source: "github",
                        occurredAt: item.updatedAt,
                        observedAt,
                        summary: "Discovered in GitHub notifications.",
                    });
                } else if (previous.updatedAt !== item.updatedAt || previous.reason !== item.reason) {
                    this.logActivity(state, current, {
                        eventKey: `notification:${item.id}:${item.updatedAt}:${item.reason}`,
                        eventType: "notification_updated",
                        source: "github",
                        occurredAt: item.updatedAt,
                        observedAt,
                        summary: `GitHub notification updated (${String(item.reason ?? "unknown").replaceAll("_", " ")}).`,
                    });
                }
                if (previous && previous.inUnread !== item.inUnread) {
                    this.logActivity(state, current, {
                        eventKey: `unread:${item.id}:${item.inUnread}:${run.id}`,
                        eventType: "unread_status_changed",
                        source: "github_observation",
                        occurredAt: observedAt,
                        observedAt,
                        summary: `GitHub now reports this notification as ${item.inUnread ? "unread" : "read"}.`,
                    });
                }
                const status = statuses.get(item.id)?.status;
                if (previous?.status && status && previous.status !== status) {
                    this.logActivity(state, current, {
                        eventKey: `status:${item.id}:${status}:${item.updatedAt}`,
                        eventType: "thread_status_changed",
                        source: "github",
                        occurredAt: item.updatedAt,
                        observedAt,
                        summary: `Thread status changed to ${status.replaceAll("_", " ")}.`,
                    });
                }
                const latest = statuses.get(item.id);
                if (checkedActivity && latest?.recentActivity && latest.recentActivity !== "No timeline activity found.") {
                    this.logActivity(state, current, {
                        eventKey: `timeline:${item.id}:${latest.recentActivityOccurredAt ?? item.updatedAt}:${latest.recentActivity}`,
                        eventType: "github_timeline_activity",
                        source: "github",
                        actor: latest.recentActivityActor,
                        occurredAt: latest.recentActivityOccurredAt ?? item.updatedAt,
                        observedAt,
                        summary: latest.recentActivity,
                    });
                }
                if (previous?.filed && !stillFiled) {
                    this.logActivity(state, current, {
                        eventKey: `resurfaced:${item.id}:${item.updatedAt}:${resumed.reason}`,
                        eventType: "automatically_resurfaced",
                        source: "local_rule",
                        occurredAt: item.updatedAt,
                        observedAt,
                        summary: `Automatically returned to Needs me after ${resumed.reason.replaceAll("_", " ")}.`,
                        details: { refreshId: run.id, archivedAt: resumed.archivedAt },
                    });
                }
                this.logDecision(state, current, previous, { trigger: "refresh", refreshId: run.id, observedAt });
                return current;
            });
            for (const item of existing.values()) {
                const retainedItem = {
                    ...item, ...statuses.get(item.id), inUnread: false,
                    githubUnread: null, inGithubNotifications: false,
                };
                if (item.inGithubNotifications !== false) {
                    this.logActivity(state, retainedItem, {
                        eventKey: `missing:${item.id}:${run.id}`,
                        eventType: "notification_missing",
                        source: "github_observation",
                        occurredAt: observedAt,
                        observedAt,
                        summary: "Not returned by GitHub; kept locally. Its current GitHub read state is unknown.",
                        details: { refreshId: run.id },
                    });
                }
                this.logDecision(state, retainedItem, item, { trigger: "refresh", refreshId: run.id, observedAt });
                state.items.push(retainedItem);
            }
            state.login = identity.login;
            state.unreadCount = run.unreadCount;
            state.lastRefresh = observedAt;
            run.status = "succeeded";
            run.stage = "complete";
            run.completedAt = observedAt;
            this.saveRefreshRun(db, run);
        });
    }

    async findFreshAttention(items, previousItems, statuses, login) {
        const candidates = [];
        const surfaced = new Map();
        const checks = [];
        for (const item of items) {
            const previous = previousItems.get(item.id);
            if (!previous?.filed) continue;
            const archivedAt = previous.filedAt ?? previous.updatedAt;
            if (Date.parse(item.updatedAt) <= Date.parse(archivedAt)) {
                checks.push({ item, archivedAt, reason: null, evidence: { rule: "update_not_newer_than_archive", updatedAt: item.updatedAt } });
                continue;
            }
            if (previous.reason !== item.reason && needsAttention(item.reason) && !["Issue", "PullRequest"].includes(item.type)) {
                surfaced.set(item.id, { archivedAt, reason: item.reason });
            } else {
                candidates.push({ item, archivedAt, authorLogin: statuses.get(item.id)?.authorLogin });
            }
        }

        // Timeline reads are needed only when an archived thread changed without
        // a new direct notification reason; bound concurrency across repositories.
        let next = 0;
        const worker = async () => {
            while (next < candidates.length) {
                const candidate = candidates[next++];
                const { reason, evidence } = await this.attentionAfterArchive(candidate, login);
                checks.push({ ...candidate, reason, evidence });
                if (reason) surfaced.set(candidate.item.id, { archivedAt: candidate.archivedAt, reason });
            }
        };
        await Promise.all(Array.from({ length: Math.min(5, candidates.length) }, worker));
        return { surfaced, checks };
    }

    async attentionAfterArchive({ item, archivedAt, authorLogin }, login) {
        const match = /^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:pull|issues)\/(\d+)$/.exec(item.url);
        if (!match) return { reason: null, evidence: { rule: "unsupported_timeline" } };
        const pages = await this.client(`repos/${item.repo}/issues/${match[1]}/timeline?per_page=100`, true);
        if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) {
            throw new Error("GitHub returned an unexpected timeline format while checking archived activity.");
        }
        const archivedTime = Date.parse(archivedAt);
        const latestNotificationTime = Date.parse(item.updatedAt) + 2 * 60 * 1000;
        if (!Number.isFinite(archivedTime) || !Number.isFinite(latestNotificationTime)) {
            throw new Error("Cannot compare archive and activity timestamps.");
        }
        const timeline = pages.flat();
        const recent = timeline.filter(event => {
            const at = Date.parse(event.submitted_at ?? event.created_at);
            return Number.isFinite(at) && at > archivedTime && at <= latestNotificationTime;
        });
        const teamRequests = recent.filter(event => event.event === "review_requested" && event.requested_team?.slug);
        const teamSlugs = teamRequests.length ? await this.getTeamMemberships(login) : new Set();
        const actorOf = event => event.user?.login ?? event.actor?.login ?? event.review?.user?.login;
        const interactionEvents = new Set(["commented", "review_comment", "reviewed"]);
        const hasInteracted = item.type === "PullRequest" && timeline.some(event =>
            interactionEvents.has(event.event) && actorOf(event) === login);
        const commentEvents = new Set(["commented", "review_comment"]);
        const reasonFor = event => {
            const actor = actorOf(event);
            if (event.event === "mentioned" && actor === login) {
                return item.reason === "team_mention" ? "team_mention" : "mention";
            }
            if (event.event === "assigned" && event.assignee?.login === login) return "assign";
            if (event.event === "review_requested" &&
                (event.requested_reviewer?.login === login || teamSlugs.has(event.requested_team?.slug))) {
                return "review_requested";
            }
            // A new comment matters only when the user has participated in this PR's discussion.
            if (item.type === "PullRequest" && commentEvents.has(event.event)) {
                return hasInteracted && actor && actor !== login ? "author" : null;
            }
            if (authorLogin === login) return "author";
            return null;
        };
        const evaluated = recent
            .map(event => ({ event, at: Date.parse(event.submitted_at ?? event.created_at) }))
            .sort((left, right) => right.at - left.at)
            .map(({ event }) => ({
                type: event.event, actor: actorOf(event) ?? null,
                occurredAt: event.submitted_at ?? event.created_at,
                reviewState: event.state ?? null,
                requestedReviewer: event.requested_reviewer?.login ?? null,
                requestedTeam: event.requested_team?.slug ?? null,
                reason: reasonFor(event),
            }));
        return {
            reason: evaluated.find(event => event.reason)?.reason ?? null,
            evidence: { rule: "timeline_after_archive", updatedAt: item.updatedAt, authorLogin: authorLogin ?? null, hasInteracted, events: evaluated },
        };
    }

    async getTeamMemberships(login) {
        if (this.teamMemberships && this.teamMembershipsLogin === login) return this.teamMemberships;
        const pages = await this.client("user/teams?per_page=100", true);
        if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) {
            throw new Error("GitHub returned an unexpected team-membership format.");
        }
        this.teamMembershipsLogin = login;
        this.teamMemberships = new Set(pages.flat().map(team => team.slug).filter(Boolean));
        return this.teamMemberships;
    }

    async loadStatuses(items, activityIds = new Set()) {
        const byRepository = new Map();
        for (const item of items) {
            if (!item.number || !["Issue", "PullRequest"].includes(item.type)) continue;
            const match = /^([^/]+)\/([^/]+)$/.exec(item.repo);
            if (!match) continue;
            if (!byRepository.has(item.repo)) byRepository.set(item.repo, { owner: match[1], name: match[2], items: new Map() });
            const threads = byRepository.get(item.repo).items;
            if (!threads.has(item.number)) threads.set(item.number, { item, ids: [], includeActivity: false });
            const thread = threads.get(item.number);
            thread.ids.push(item.id);
            thread.includeActivity ||= activityIds.has(item.id);
        }

        const statuses = new Map();
        for (const [repo, group] of byRepository) {
            const entries = [...group.items.values()];
            // Keep each GraphQL operation bounded while resolving many threads in one request.
            for (let start = 0; start < entries.length; start += 50) {
                const batch = entries.slice(start, start + 50);
                const variables = { owner: group.owner, name: group.name };
                const definitions = ["$owner: String!", "$name: String!"];
                const fields = batch.map(({ item, includeActivity }, index) => {
                    const variable = `number${index}`;
                    definitions.push(`$${variable}: Int!`);
                    variables[variable] = Number(item.number);
                    const issueActivity = includeActivity ?
                        `timelineItems(last: 1, itemTypes: [${issueActivityTypes.join(", ")}]) { nodes { ${issueActivityFields} } }` : "";
                    const pullRequestActivity = includeActivity ?
                        `timelineItems(last: 1, itemTypes: [${pullRequestActivityTypes.join(", ")}]) { nodes { ${pullRequestActivityFields} } }` : "";
                    return `item${index}: issueOrPullRequest(number: $${variable}) {
                        __typename
                        ... on Issue { state stateReason author { login } ${issueActivity} }
                        ... on PullRequest { state isDraft merged author { login } ${pullRequestActivity} }
                    }`;
                });
                const query = `query(${definitions.join(", ")}) {
                    repository(owner: $owner, name: $name) { ${fields.join("\n")} }
                }`;
                const response = await this.graphqlClient(query, variables);
                if (response.errors?.length) {
                    throw new Error(`GitHub status lookup failed for ${repo}: ${response.errors.map(error => error.message).join("; ")}`);
                }
                const repository = response.data?.repository;
                if (!repository) throw new Error(`GitHub did not return status data for ${repo}.`);
                for (const [index, entry] of batch.entries()) {
                    const { item, ids, includeActivity } = entry;
                    const node = repository[`item${index}`];
                    const status = this.statusFromNode(item.type, node);
                    if (includeActivity) {
                        const event = node?.timelineItems?.nodes?.[0];
                        status.recentActivity = this.summarizeActivity(event);
                        status.recentActivityOccurredAt = event?.submittedAt ?? event?.createdAt ??
                            event?.comments?.nodes?.[0]?.createdAt ?? null;
                        status.recentActivityActor = event?.author?.login ?? event?.actor?.login ??
                            event?.comments?.nodes?.[0]?.author?.login ?? null;
                    }
                    for (const id of ids) statuses.set(id, status);
                }
            }
        }
        return statuses;
    }

    summarizeActivity(event) {
        if (!event) return "No timeline activity found.";
        const actor = event.author?.login ?? event.actor?.login;
        const by = actor ? ` by ${actor}` : "";
        if (event.__typename === "IssueComment") return `Comment added${by}.`;
        if (event.__typename === "PullRequestReviewThread") {
            const commenter = event.comments?.nodes?.[0]?.author?.login;
            return `Inline review comment added${commenter ? ` by ${commenter}` : ""}.`;
        }
        if (event.__typename === "PullRequestReview") {
            if (event.state === "APPROVED") return `Approved${by}.`;
            if (event.state === "CHANGES_REQUESTED") return `Changes requested${by}.`;
            if (event.state === "DISMISSED") return `Review dismissed${by}.`;
            return `Review submitted${by}.`;
        }
        const summaries = {
            AssignedEvent: "Assignee added",
            UnassignedEvent: "Assignee removed",
            ReviewRequestedEvent: "Review requested",
            LabeledEvent: "Label added",
            UnlabeledEvent: "Label removed",
            MilestonedEvent: "Added to a milestone",
            DemilestonedEvent: "Removed from a milestone",
            RenamedTitleEvent: "Thread title changed",
            LockedEvent: "Thread locked",
            UnlockedEvent: "Thread unlocked",
            ClosedEvent: "Thread closed",
            ReopenedEvent: "Thread reopened",
            MergedEvent: "Pull request merged",
            ReadyForReviewEvent: "Marked ready for review",
            ConvertToDraftEvent: "Converted to draft",
            HeadRefForcePushedEvent: "Pull request updated",
        };
        const summary = summaries[event.__typename] ??
            `Latest activity: ${String(event.__typename ?? "Update").replace(/Event$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2")}`;
        return `${summary}${by}.`;
    }

    statusFromNode(type, node) {
        if (type === "Issue") {
            if (node?.__typename !== "Issue") return { status: "unknown", authorLogin: null };
            if (node.state === "OPEN") return { status: "open", authorLogin: node.author?.login ?? null };
            if (node.stateReason === "COMPLETED") return { status: "completed", authorLogin: node.author?.login ?? null };
            if (node.stateReason === "NOT_PLANNED") return { status: "not_planned", authorLogin: node.author?.login ?? null };
            if (node.stateReason === "DUPLICATE") return { status: "duplicate", authorLogin: node.author?.login ?? null };
            return { status: node.state === "CLOSED" ? "closed" : "unknown", authorLogin: node.author?.login ?? null };
        }
        if (node?.__typename !== "PullRequest") return { status: "unknown", prState: null, authorLogin: null };
        if (node.merged || node.state === "MERGED") return { status: "merged", prState: "merged", authorLogin: node.author?.login ?? null };
        if (node.state === "CLOSED") return { status: "closed", prState: "closed", authorLogin: node.author?.login ?? null };
        if (node.state === "OPEN" && node.isDraft) return { status: "draft", prState: "open", authorLogin: node.author?.login ?? null };
        if (node.state === "OPEN") return { status: "open", prState: "open", authorLogin: node.author?.login ?? null };
        return { status: "unknown", prState: null, authorLogin: node.author?.login ?? null };
    }

    async setViewPreference(preference) {
        if (!preference || typeof preference !== "object" || Array.isArray(preference)) {
            throw new Error("Invalid view preference.");
        }
        const { tab, grouped, repo, expanded, activeTab, filter, value } = preference;
        const keys = Object.keys(preference).sort().join(",");
        const tabs = ["needs", "following", "followup", "snoozed", "filed"];
        const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/;
        const selection = keys === "activeTab" && tabs.includes(activeTab);
        const grouping = keys === "grouped,tab" && tabs.includes(tab) && typeof grouped === "boolean";
        const expansion = keys === "expanded,repo,tab" && tabs.includes(tab) &&
            typeof repo === "string" && repositoryPattern.test(repo) && typeof expanded === "boolean";
        const filtering = keys === "filter,value" && filter === "search" &&
            typeof value === "string" && value.length <= 4000;
        if (!selection && !grouping && !expansion && !filtering) throw new Error("Invalid view preference.");
        const identity = this.identity ?? await this.account();
        return this.transaction(identity, state => {
            state.viewPreferences ??= {};
            if (selection) state.viewPreferences.activeTab = activeTab;
            else if (filtering) {
                const filters = state.viewPreferences.filters ??= {};
                delete filters.repo;
                delete filters.before;
                filters.search = value;
            }
            else {
                state.viewPreferences.tabs ??= {};
                const preferences = state.viewPreferences.tabs[tab] ??= {};
                if (grouping) preferences.grouped = grouped;
                else (preferences.repositories ??= {})[repo] = expanded;
            }
        });
    }

    async change({ ids, action, until, note }) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some(id => typeof id !== "string")) {
            throw new Error("Choose between 1 and 1000 notification IDs.");
        }
        if (!["save", "unsave", "snooze", "wake", "file", "restore", "note"].includes(action)) throw new Error("Unknown triage action.");
        if (action === "snooze" && (!Number.isFinite(Date.parse(until)) || Date.parse(until) <= Date.now())) throw new Error("Snooze time must be in the future.");
        if (action === "note" && (typeof note !== "string" || note.length > 4000)) throw new Error("Notes must be at most 4000 characters.");
        const identity = this.identity ?? await this.account();
        const filedAt = action === "file" ? new Date().toISOString() : null;
        const occurredAt = filedAt ?? new Date().toISOString();
        const summaries = {
            save: "Kept for follow-up.",
            unsave: "Removed from follow-up.",
            snooze: `Snoozed until ${new Date(until).toLocaleString()}.`,
            wake: "Woke from snooze.",
            file: "Archived in the local inbox.",
            restore: "Restored from the local archive.",
            note: "Updated the follow-up note.",
        };
        return this.transaction(identity, state => {
            const selected = new Set(ids);
            if (ids.some(id => !state.items.some(item => item.id === id))) throw new Error("A selected notification no longer exists. Refresh the panel.");
            for (const item of state.items) {
                if (!selected.has(item.id)) continue;
                const previous = { ...item };
                if (action === "save") { item.saved = true; item.filed = false; item.filedAt = null; }
                if (action === "unsave") item.saved = false;
                if (action === "snooze") item.snoozedUntil = new Date(until).toISOString();
                if (action === "wake") item.snoozedUntil = null;
                if (action === "file") { item.filed = true; item.filedAt = filedAt; }
                if (action === "restore") { item.filed = false; item.filedAt = null; item.snoozedUntil = null; }
                if (action === "note") item.note = note;
                this.logActivity(state, item, {
                    eventType: action,
                    source: "local_user",
                    actor: identity.login,
                    occurredAt,
                    observedAt: occurredAt,
                    summary: summaries[action],
                });
                this.logDecision(state, item, previous, { trigger: action, observedAt: occurredAt });
            }
        });
    }
}
