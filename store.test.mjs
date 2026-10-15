import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TriageStore, githubGraphql } from "./store.mjs";
import { bucket, groupByRepository } from "./rules.mjs";
import { startServer } from "./server.mjs";

const execute = promisify(execFile);

test("GraphQL transports full activity batches through stdin rather than command arguments", async () => {
    const query = "query { __typename } ".repeat(6000);
    const variables = { owner: "dotnet", name: "roslyn", number0: 85810 };
    const response = await githubGraphql(query, variables, (command, args, options) => {
        assert.equal(command, "gh");
        assert.deepEqual(args, ["api", "graphql", "--hostname", "github.com", "--input", "-"]);
        return execute(process.execPath, ["-e", `
            let input = "";
            process.stdin.setEncoding("utf8");
            process.stdin.on("data", chunk => { input += chunk; });
            process.stdin.on("end", () => { process.stdout.write(JSON.stringify({ data: JSON.parse(input) })); });
        `], options);
    });
    assert.deepEqual(response, { data: { query, variables } });
});

test("GraphQL transport preserves command failures when the process rejects its input", async () => {
    await assert.rejects(githubGraphql("query { __typename } ".repeat(6000), {}, (_, __, options) =>
        execute(process.execPath, ["-e", 'process.stderr.write("GitHub unavailable"); process.exit(1);'], options)),
    error => error.code === 1 && error.stderr === "GitHub unavailable");
});

const notification = (id, reason = "subscribed", updated = "2026-10-13T10:00:00Z") => ({
    id, reason, updated_at: updated, unread: true,
    repository: { full_name: "dotnet/roslyn", html_url: "https://github.com/dotnet/roslyn" },
    subject: { title: `Thread ${id}`, type: "PullRequest", url: `https://api.github.com/repos/dotnet/roslyn/pulls/${id}` },
});
const issueNotification = (id, reason = "subscribed", updated = "2026-10-13T10:00:00Z") => ({
    ...notification(id, reason, updated),
    subject: { title: `Issue ${id}`, type: "Issue", url: `https://api.github.com/repos/dotnet/roslyn/issues/${id}` },
});

async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), "notification-triage-test-"));
    const stores = new Set();
    const createStore = (...args) => {
        const store = new TriageStore(...args);
        stores.add(store);
        return store;
    };
    t.after(async () => {
        await Promise.all([...stores].map(store => store.close()));
        await rm(directory, { recursive: true });
    });
    const data = { pages: [[notification("1", "review_requested")], [notification("2")]], timeline: [[]], statuses: {}, activity: {}, teams: [], graphqlError: null, user: { id: 123, login: "example" } };
    const client = async (endpoint, paginate) => {
        if (endpoint === "user") {
            if (data.accountError) throw data.accountError;
            return data.user;
        }
        if (endpoint === "user/teams?per_page=100") {
            assert.equal(paginate, true);
            return [data.teams];
        }
        if (/^repos\/dotnet\/roslyn\/issues\/\d+\/timeline\?per_page=100$/.test(endpoint)) {
            assert.equal(paginate, true);
            return data.timeline;
        }
        assert.equal(endpoint, "notifications?all=true&per_page=100");
        assert.equal(paginate, true);
        if (data.notificationError) throw data.notificationError;
        return data.pages;
    };
    const graphqlCalls = [];
    const graphqlClient = async (query, variables) => {
        graphqlCalls.push({ query, variables });
        if (data.graphqlError) throw data.graphqlError;
        const repository = {};
        for (const variable of Object.keys(variables).filter(key => /^number\d+$/.test(key))) {
            const index = Number(variable.slice("number".length));
            const key = `${variables.owner}/${variables.name}#${variables[variable]}`;
            const source = Object.hasOwn(data.statuses, key)
                ? data.statuses[key]
                : { __typename: "PullRequest", state: "OPEN", isDraft: false, merged: false };
            const node = source ? { ...source } : source;
            if (query.includes("timelineItems(last: 1") && node) {
                const events = [data.activity[key] ?? []].flat();
                const selectedTypes = [...query.matchAll(/itemTypes:\s*\[([^\]]*)\]/g)]
                    .flatMap(match => match[1].split(",").map(type => type.trim()));
                const relevant = selectedTypes.length ? events.filter(event =>
                    selectedTypes.includes(event.__typename.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase())) : events;
                node.timelineItems = { nodes: relevant.slice(-1) };
            }
            repository[`item${index}`] = node;
        }
        return { data: { repository } };
    };
    return { store: createStore(directory, client, graphqlClient), createStore, data, directory, client, graphqlClient, graphqlCalls };
}

test("pagination, links and deterministic buckets", async t => {
    const { store, graphqlCalls } = await fixture(t);
    const state = await store.refresh();
    assert.equal(state.unreadCount, 2);
    assert.equal(state.items[0].url, "https://github.com/dotnet/roslyn/pull/1");
    assert.equal(state.items[0].number, "1");
    assert.equal(bucket(state.items[0]), "needs");
    assert.equal(bucket(state.items[1]), "following");
    assert.deepEqual(state.items.map(item => item.status), ["open", "open"]);
    assert.equal(graphqlCalls.length, 1);
});

test("an already-read approval on an authored PR is discovered in Needs me and audited", async t => {
    const { store, data, createStore, directory, client, graphqlClient } = await fixture(t);
    data.pages = [[{ ...notification("86072", "author"), unread: false }]];
    data.statuses["dotnet/roslyn#86072"] = {
        __typename: "PullRequest", state: "OPEN", isDraft: false, merged: false, author: { login: "example" },
    };
    data.activity["dotnet/roslyn#86072"] = {
        __typename: "PullRequestReview", state: "APPROVED", submittedAt: "2026-10-13T09:59:00Z",
        author: { login: "reviewer" },
    };
    const state = await store.refresh();
    assert.equal(state.unreadCount, 0);
    assert.equal(bucket(state.items[0]), "needs");
    assert.equal(state.items[0].inUnread, false);
    assert.equal(state.items[0].recentActivity, "Approved by reviewer.");
    const reopened = createStore(directory, client, graphqlClient);
    const audit = await reopened.diagnose("dotnet/roslyn", 86072);
    assert.equal(audit.items[0].classification.bucket, "needs");
    const receipt = audit.events.find(event => event.eventType === "notification_observed");
    const decision = audit.events.find(event => event.eventType === "triage_decision");
    assert.equal(receipt.details.githubUnread, false);
    assert.equal(decision.details.bucket, "needs");
    assert.equal(decision.details.rule, "direct_attention");
    assert.equal(decision.details.inputs.reason, "author");
    assert.equal(decision.details.inputs.recentActivity, "Approved by reviewer.");
    assert.equal(decision.details.refreshId, receipt.details.refreshId);
    assert.equal(audit.recentRefreshes[0].status, "succeeded");
    assert.equal(audit.recentRefreshes[0].endpoint, "notifications?all=true&per_page=100");
});

test("notification receipts survive a failed lookup without replacing the inbox", async t => {
    const { store, data } = await fixture(t);
    const before = await store.refresh();
    data.pages = [[{ ...notification("86072", "author"), unread: false }]];
    data.graphqlError = new Error("GitHub status lookup unavailable");
    await assert.rejects(store.refresh(), /lookup unavailable/);
    assert.deepEqual(await store.snapshot(), before);
    const audit = await store.diagnose("dotnet/roslyn", 86072);
    assert.equal(audit.items.length, 0);
    assert.equal(audit.events[0].eventType, "notification_observed");
    assert.equal(audit.recentRefreshes[0].status, "failed");
    assert.equal(audit.recentRefreshes[0].stage, "statuses");
    assert.match(audit.recentRefreshes[0].error, /lookup unavailable/);
    assert.equal(audit.recentRefreshes[0].id, audit.events[0].details.refreshId);
});

test("fetch and authentication failures are recorded, including runs returning no notifications", async t => {
    const { store, data } = await fixture(t);
    data.pages = [[]];
    await store.refresh();
    let audit = await store.diagnose("dotnet/roslyn", 86072);
    assert.equal(audit.recentRefreshes[0].notificationCount, 0);
    assert.equal(audit.recentRefreshes[0].status, "succeeded");
    data.notificationError = new Error("Notifications unavailable");
    await assert.rejects(store.refresh(), /Notifications unavailable/);
    audit = await store.diagnose("dotnet/roslyn", 86072);
    assert.equal(audit.recentRefreshes[0].stage, "notifications");
    assert.equal(audit.recentRefreshes[0].status, "failed");
    data.accountError = new Error("Not authenticated");
    await assert.rejects(store.refresh(), /Not authenticated/);
    audit = await store.diagnose("dotnet/roslyn", 86072);
    assert.equal(audit.recentRefreshes[0].stage, "account");
    assert.equal(audit.recentRefreshes[0].accountId, null);
});

test("malformed notifications leave rejection evidence without replacing the inbox", async t => {
    const { store, data } = await fixture(t);
    const before = await store.refresh();
    const malformed = notification("86072", "author");
    delete malformed.unread;
    data.pages = [[malformed]];
    await assert.rejects(store.refresh(), /unsupported notification shape/);
    assert.deepEqual(await store.snapshot(), before);
    const audit = await store.diagnose("dotnet/roslyn", 86072);
    assert.equal(audit.events[0].eventType, "notification_rejected");
    assert.equal(audit.recentRefreshes[0].stage, "normalization");
    assert.equal(audit.recentRefreshes[0].notificationCount, 1);
});

test("audit history is paginated, durable and isolated by account", async t => {
    const { store, data, createStore, directory, client, graphqlClient } = await fixture(t);
    await store.refresh();
    await store.transaction(store.identity, state => {
        for (let index = 0; index < 205; index++) {
            store.logActivity(state, state.items[0], {
                eventType: "audit_test", source: "local_rule", summary: `Test observation ${index}.`,
            });
        }
    });
    const reopened = createStore(directory, client, graphqlClient);
    const first = await reopened.diagnose("dotnet/roslyn", 1);
    assert.equal(first.events.length, 200);
    assert.equal(first.hasMoreEvents, true);
    const second = await reopened.diagnose("dotnet/roslyn", 1, first.nextBeforeSequence);
    assert.equal(second.hasMoreEvents, false);
    assert.ok(second.events.length > 0);
    assert.ok(second.relatedRefreshes.some(run => run.status === "succeeded"));
    assert.equal(new Set([...first.events, ...second.events].map(event => event.sequence)).size,
        first.events.length + second.events.length);
    data.user = { id: 456, login: "second" };
    await reopened.refresh();
    const otherAccount = await reopened.diagnose("dotnet/roslyn", 1);
    assert.equal(otherAccount.events.some(event => event.eventType === "audit_test"), false);
    assert.ok(otherAccount.recentRefreshes.every(run => run.accountId === 456));
});

test("the audit schema upgrades a v1 database without changing its inbox", async t => {
    const { store, createStore, directory, client, graphqlClient } = await fixture(t);
    const before = await store.refresh();
    const db = await store.database();
    db.exec("DROP TABLE refresh_runs; PRAGMA user_version = 1");
    await store.close();
    const reopened = createStore(directory, client, graphqlClient);
    assert.deepEqual(await reopened.snapshot(), before);
    assert.equal((await reopened.database()).prepare("PRAGMA user_version").get().user_version, 2);
    await reopened.refresh();
    assert.equal((await reopened.diagnose("dotnet/roslyn", 1)).recentRefreshes[0].status, "succeeded");
});

test("read flags cannot undo an archive, but a later approval of an authored PR can", async t => {
    const { store, data } = await fixture(t);
    data.pages = [[notification("86072", "author")]];
    data.statuses["dotnet/roslyn#86072"] = {
        __typename: "PullRequest", state: "OPEN", isDraft: false, merged: false, author: { login: "example" },
    };
    await store.refresh();
    const archived = await store.change({ ids: ["86072"], action: "file" });
    const archivedAt = archived.items[0].filedAt;
    data.pages[0][0].unread = false;
    assert.equal(bucket((await store.refresh()).items[0]), "filed");
    const approvedAt = new Date(Date.parse(archivedAt) + 1000).toISOString();
    data.pages[0][0].updated_at = approvedAt;
    data.timeline = [[{
        event: "reviewed", state: "approved", submitted_at: approvedAt, user: { login: "reviewer" },
    }]];
    data.activity["dotnet/roslyn#86072"] = {
        __typename: "PullRequestReview", state: "APPROVED", submittedAt: approvedAt, author: { login: "reviewer" },
    };
    assert.equal(bucket((await store.refresh()).items[0]), "needs");
    const audit = await store.diagnose("dotnet/roslyn", 86072);
    const archiveCheck = audit.events.find(event => event.eventType === "archive_attention_checked");
    assert.equal(archiveCheck.details.archivedAt, archivedAt);
    assert.equal(archiveCheck.details.events[0].reviewState, "approved");
    assert.equal(archiveCheck.details.events[0].reason, "author");
    assert.equal(audit.events.find(event => event.eventType === "triage_decision").details.bucket, "needs");
});

test("review requests on merged or closed PRs are not Needs me, and failed lookups never hide them", async t => {
    const { store, data } = await fixture(t);
    data.pages = [[notification("1", "review_requested"), notification("2", "review_requested"), notification("3", "review_requested"), notification("4", "mention")]];
    data.statuses = {
        "dotnet/roslyn#1": { __typename: "PullRequest", state: "MERGED", isDraft: false, merged: true },
        "dotnet/roslyn#2": { __typename: "PullRequest", state: "CLOSED", isDraft: false, merged: false },
        "dotnet/roslyn#3": null,
        "dotnet/roslyn#4": { __typename: "PullRequest", state: "MERGED", isDraft: false, merged: true },
    };
    const state = await store.refresh();
    const bucketOf = id => bucket(state.items.find(item => item.id === id));
    assert.equal(bucketOf("1"), "following");
    assert.equal(bucketOf("2"), "following");
    assert.equal(bucketOf("3"), "needs");
    // Only review requests are affected; a mention on a merged PR is still worth seeing.
    assert.equal(bucketOf("4"), "needs");
});

test("issue and pull request statuses are fetched in batches per repository", async t => {
    const { store, data, graphqlCalls } = await fixture(t);
    const otherRepositoryIssue = issueNotification("8");
    otherRepositoryIssue.repository = { full_name: "dotnet/razor", html_url: "https://github.com/dotnet/razor" };
    otherRepositoryIssue.subject.url = "https://api.github.com/repos/dotnet/razor/issues/8";
    data.pages = [[
        issueNotification("1"), issueNotification("2"), issueNotification("3"), issueNotification("4"),
        notification("5"), notification("6"), notification("7"), otherRepositoryIssue,
    ]];
    data.statuses = {
        "dotnet/roslyn#1": { __typename: "Issue", state: "OPEN", stateReason: null },
        "dotnet/roslyn#2": { __typename: "Issue", state: "CLOSED", stateReason: "COMPLETED" },
        "dotnet/roslyn#3": { __typename: "Issue", state: "CLOSED", stateReason: "NOT_PLANNED" },
        "dotnet/roslyn#4": { __typename: "Issue", state: "CLOSED", stateReason: "DUPLICATE" },
        "dotnet/roslyn#5": { __typename: "PullRequest", state: "OPEN", isDraft: false, merged: false },
        "dotnet/roslyn#6": { __typename: "PullRequest", state: "OPEN", isDraft: true, merged: false },
        "dotnet/roslyn#7": { __typename: "PullRequest", state: "CLOSED", isDraft: false, merged: false },
        "dotnet/razor#8": { __typename: "Issue", state: "CLOSED", stateReason: "COMPLETED" },
    };
    const state = await store.refresh();
    assert.deepEqual(state.items.map(item => item.status), [
        "open", "completed", "not_planned", "duplicate", "open", "draft", "closed", "completed",
    ]);
    assert.deepEqual(state.items.slice(4, 7).map(item => item.prState), ["open", "open", "closed"]);
    assert.equal(graphqlCalls.length, 2);
    assert.ok(graphqlCalls.every(call => call.query.includes("issueOrPullRequest")));
});

test("latest activity is batched with statuses and cached until the notification updates", async t => {
    const { store, data, graphqlCalls } = await fixture(t);
    const firstActivity = { __typename: "PullRequestReview", state: "APPROVED", author: { login: "reviewer" } };
    data.activity["dotnet/roslyn#1"] = firstActivity;

    let state = await store.refresh();
    let item = state.items.find(candidate => candidate.id === "1");
    assert.equal(item.recentActivity, "Approved by reviewer.");
    assert.equal(item.activityUpdatedAt, item.updatedAt);
    assert.equal(graphqlCalls.length, 1);
    assert.match(graphqlCalls[0].query, /timelineItems\(last: 1, itemTypes:/);

    data.activity["dotnet/roslyn#1"] = { __typename: "IssueComment", author: { login: "teammate" } };
    state = await store.refresh();
    item = state.items.find(candidate => candidate.id === "1");
    assert.equal(item.recentActivity, "Approved by reviewer.");
    assert.doesNotMatch(graphqlCalls[1].query, /timelineItems\(last: 1/);

    data.pages[0][0].updated_at = "2026-10-13T10:01:00Z";
    state = await store.refresh();
    item = state.items.find(candidate => candidate.id === "1");
    assert.equal(item.recentActivity, "Comment added by teammate.");
    assert.match(graphqlCalls[2].query, /timelineItems\(last: 1, itemTypes:/);
});

test("bookkeeping after a comment cannot replace it, including in existing cached summaries", async t => {
    const { store, data, graphqlCalls } = await fixture(t);
    data.activity["dotnet/roslyn#1"] = [
        { __typename: "IssueComment", author: { login: "missymessa" } },
        { __typename: "MentionedEvent", actor: { login: "example" } },
        { __typename: "SubscribedEvent", actor: { login: "example" } },
    ];
    let state = await store.refresh();
    assert.equal(state.items[0].recentActivity, "Comment added by missymessa.");
    assert.doesNotMatch(graphqlCalls[0].query, /\b(?:SUBSCRIBED|UNSUBSCRIBED|MENTIONED)_EVENT\b/);

    await store.transaction(store.identity, saved => {
        saved.items[0].recentActivity = "Latest activity: Subscribed.";
        delete saved.items[0].activityVersion;
    });
    state = await store.refresh();
    assert.equal(state.items[0].recentActivity, "Comment added by missymessa.");
    assert.equal(state.items[0].activityUpdatedAt, data.pages[0][0].updated_at);
    assert.match(graphqlCalls[1].query, /timelineItems\(last: 1, itemTypes:/);
});

test("status batches contain no more than 50 threads", async t => {
    const { store, graphqlCalls } = await fixture(t);
    const items = Array.from({ length: 51 }, (_, index) => ({
        id: String(index), repo: "dotnet/roslyn", number: String(index + 1), type: "Issue",
    }));
    const statuses = await store.loadStatuses(items);
    assert.equal(statuses.size, 51);
    assert.equal(graphqlCalls.length, 2);
    assert.deepEqual(graphqlCalls.map(call => Object.keys(call.variables).filter(key => /^number\d+$/.test(key)).length), [50, 1]);
});

test("discovered items remain local after leaving unread and failures preserve the snapshot", async t => {
    const { store, data } = await fixture(t);
    await store.refresh();
    await store.change({ ids: ["2"], action: "save" });
    data.pages = [[]];
    data.statuses["dotnet/roslyn#2"] = { __typename: "PullRequest", state: "MERGED", isDraft: false, merged: true };
    let state = await store.refresh();
    assert.equal(state.items.find(item => item.id === "2").status, "merged");
    assert.equal(state.items.find(item => item.id === "1").inUnread, false);
    const previous = state;
    data.graphqlError = new Error("GraphQL unavailable");
    await assert.rejects(store.refresh(), /GraphQL unavailable/);
    state = await store.snapshot();
    assert.deepEqual(state, previous);
});

test("activity history records timeline, local actions and unread observations without note text", async t => {
    const { store, data } = await fixture(t);
    await store.refresh();
    data.pages[0][0].updated_at = "2026-10-15T10:00:00Z";
    data.activity["dotnet/roslyn#1"] = {
        __typename: "IssueComment", createdAt: "2026-10-15T09:59:00Z", author: { login: "reviewer" },
    };
    await store.refresh();
    await store.change({ ids: ["1"], action: "file" });
    await store.change({ ids: ["1"], action: "note", note: "private note body" });
    data.pages[0][0].unread = false;
    await store.refresh();
    data.pages = [[]];
    await store.refresh();

    const events = await store.activity("1");
    const eventTypes = new Set(events.map(event => event.eventType));
    assert.ok(eventTypes.has("discovered"));
    assert.ok(eventTypes.has("github_timeline_activity"));
    assert.ok(eventTypes.has("file"));
    assert.ok(eventTypes.has("note"));
    assert.ok(eventTypes.has("unread_status_changed"));
    assert.ok(eventTypes.has("notification_missing"));
    const timeline = events.find(event => event.eventType === "github_timeline_activity");
    assert.equal(timeline.occurredAt, "2026-10-15T09:59:00Z");
    assert.ok(timeline.observedAt);
    assert.equal(JSON.stringify(events).includes("private note body"), false);
});

test("legacy JSON is imported once and remains unchanged as a backup", async t => {
    const { store, directory } = await fixture(t);
    const legacy = {
        version: 1, accountId: 123, login: "example", lastRefresh: null, unreadCount: 0,
        items: [{
            id: "legacy", repo: "dotnet/roslyn", number: "8", title: "Legacy issue", type: "Issue",
            reason: "subscribed", updatedAt: "2026-10-13T10:00:00Z",
            url: "https://github.com/dotnet/roslyn/issues/8", inUnread: false,
        }],
    };
    const backup = JSON.stringify(legacy);
    const legacyPath = join(directory, "123.json");
    await writeFile(legacyPath, backup, "utf8");
    assert.equal((await store.snapshot()).items[0].id, "legacy");
    assert.equal((await store.activity("legacy"))[0].eventType, "legacy_imported");
    assert.equal(await readFile(legacyPath, "utf8"), backup);
});

test("repository groups are alphabetical and retain item order when archiving", () => {
    const items = [
        { id: "1", repo: "other/tool" },
        { id: "2", repo: "dotnet/roslyn" },
        { id: "3", repo: "dotnet/razor" },
        { id: "4", repo: "dotnet/roslyn" },
        { id: "5", repo: "other/tool" },
    ];
    const groups = groupByRepository(items);
    assert.deepEqual(groups.map(([repo]) => repo), ["dotnet/razor", "dotnet/roslyn", "other/tool"]);
    assert.deepEqual(groups[1][1].map(item => item.id), ["2", "4"]);
    assert.deepEqual(groupByRepository(items.slice(1)).map(([repo]) => repo), groups.map(([repo]) => repo));
    assert.deepEqual(items.map(item => item.id), ["1", "2", "3", "4", "5"]);
});

test("follow-up and notes survive refresh, restart and leaving unread", async t => {
    const { store, data, directory, client, graphqlClient, createStore } = await fixture(t);
    await store.refresh();
    await store.change({ ids: ["2"], action: "save" });
    await store.change({ ids: ["2"], action: "note", note: "Waiting for an answer" });
    data.pages = [[]];
    await store.refresh();
    const restarted = createStore(directory, client, graphqlClient);
    const saved = (await restarted.snapshot()).items.find(item => item.id === "2");
    assert.equal(bucket(saved), "followup");
    assert.equal(saved.note, "Waiting for an answer");
    assert.equal(saved.inUnread, false);
});

test("generic updates leave filed items archived, while a fresh mention resurfaces", async t => {
    const { store, data } = await fixture(t);
    await store.refresh();
    let state = await store.change({ ids: ["2"], action: "file" });
    assert.equal(bucket(state.items[1]), "filed");
    assert.ok(state.items[1].filedAt);
    state = await store.refresh();
    assert.equal(bucket(state.items[1]), "filed");
    state = await store.change({ ids: ["2"], action: "restore" });
    assert.equal(bucket(state.items[1]), "following");
    await store.change({ ids: ["2"], action: "file" });
    const genericUpdate = new Date(Date.now() + 1000).toISOString();
    data.pages[1][0].updated_at = genericUpdate;
    state = await store.refresh();
    assert.equal(bucket(state.items[1]), "filed");

    const mentionAt = new Date(Date.parse(genericUpdate) + 1000).toISOString();
    data.pages[1][0].updated_at = mentionAt;
    data.timeline = [[{ event: "mentioned", created_at: mentionAt, actor: { login: "example" } }]];
    state = await store.refresh();
    const resurfaced = state.items.find(item => item.id === "2");
    assert.equal(resurfaced.filed, false);
    assert.equal(resurfaced.reason, "mention");
    assert.equal(bucket(resurfaced), "needs");
});

test("an older mention cannot undo a later archive when GitHub refreshes a stale snapshot", async t => {
    const { store, data } = await fixture(t);
    data.pages = [[notification("1", "mention", "2026-09-30T15:32:12Z")]];
    await store.refresh();
    await store.change({ ids: ["1"], action: "file" });
    data.pages = [[notification("1", "mention", new Date(Date.now() - 1000).toISOString())]];
    data.timeline = [[{
        event: "mentioned",
        created_at: new Date(Date.now() - 1000).toISOString(),
        actor: { login: "example" },
    }]];
    const state = await store.refresh();
    const item = state.items.find(candidate => candidate.id === "1");
    assert.equal(item.filed, true);
    assert.equal(bucket(item), "filed");
});

test("archiving a Needs me item moves it to Archived until restored or a new attention reason", async t => {
    const { store, data } = await fixture(t);
    await store.refresh();
    let state = await store.change({ ids: ["1"], action: "file" });
    assert.equal(state.items.filter(item => bucket(item) === "needs").length, 0);
    assert.equal(state.items.filter(item => bucket(item) === "filed").length, 1);

    state = await store.refresh();
    assert.equal(bucket(state.items.find(item => item.id === "1")), "filed");
    state = await store.change({ ids: ["1"], action: "restore" });
    assert.equal(bucket(state.items.find(item => item.id === "1")), "needs");

    await store.change({ ids: ["1"], action: "file" });
    data.pages[0][0].reason = "mention";
    const mentionAt = new Date(Date.now() + 1000).toISOString();
    data.pages[0][0].updated_at = mentionAt;
    data.timeline = [[{ event: "mentioned", created_at: mentionAt, actor: { login: "example" } }]];
    state = await store.refresh();
    const updated = state.items.find(item => item.id === "1");
    assert.equal(updated.filed, false);
    assert.equal(bucket(updated), "needs");
});

test("a Copilot review does not revive an old mention, but a new personal review request does", async t => {
    const { store, data } = await fixture(t);
    data.pages = [[notification("85810", "mention", "2026-10-13T10:00:00Z")]];
    await store.refresh();
    const archived = await store.change({ ids: ["85810"], action: "file" });
    const archivedAt = archived.items[0].filedAt;

    const copilotReviewAt = new Date(Date.parse(archivedAt) + 1000).toISOString();
    data.pages = [[notification("85810", "mention", copilotReviewAt)]];
    data.timeline = [[
        { event: "review_requested", created_at: copilotReviewAt, requested_reviewer: { login: "Copilot" } },
        { event: "reviewed", submitted_at: new Date(Date.parse(copilotReviewAt) + 1000).toISOString(), user: { login: "Copilot" } },
    ]];
    let state = await store.refresh();
    let item = state.items.find(candidate => candidate.id === "85810");
    assert.equal(item.filed, true);
    assert.equal(bucket(item), "filed");

    const personalReviewAt = new Date(Date.parse(copilotReviewAt) + 2000).toISOString();
    data.pages[0][0].updated_at = personalReviewAt;
    data.timeline = [[
        { event: "review_requested", created_at: personalReviewAt, requested_reviewer: { login: "example" } },
    ]];
    state = await store.refresh();
    item = state.items.find(candidate => candidate.id === "85810");
    assert.equal(item.filed, false);
    assert.equal(item.reason, "review_requested");
    assert.equal(bucket(item), "needs");

    await store.change({ ids: ["85810"], action: "file" });
    data.teams = [{ slug: "example-team" }];
    const teamReviewAt = new Date(Date.now() + 3000).toISOString();
    data.pages[0][0].updated_at = teamReviewAt;
    data.timeline = [[{
        event: "review_requested",
        created_at: teamReviewAt,
        requested_team: { slug: "example-team" },
    }]];
    state = await store.refresh();
    item = state.items.find(candidate => candidate.id === "85810");
    assert.equal(item.filed, false);
    assert.equal(item.reason, "review_requested");
    assert.equal(bucket(item), "needs");
});

test("a new PR comment revives an archive only after the user has participated", async t => {
    const { store, data } = await fixture(t);
    data.pages = [[notification("2")]];
    await store.refresh();
    let state = await store.change({ ids: ["2"], action: "file" });
    let archivedAt = Date.parse(state.items.find(item => item.id === "2").filedAt);

    const firstCommentAt = new Date(archivedAt + 1000).toISOString();
    data.pages[0][0].updated_at = firstCommentAt;
    data.timeline = [[{ event: "commented", created_at: firstCommentAt, actor: { login: "reviewer" } }]];
    state = await store.refresh();
    let item = state.items.find(candidate => candidate.id === "2");
    assert.equal(item.filed, true);
    assert.equal(bucket(item), "filed");

    await store.change({ ids: ["2"], action: "restore" });
    const userReviewAt = new Date(Date.parse(firstCommentAt) + 1000).toISOString();
    data.pages[0][0].updated_at = userReviewAt;
    data.timeline = [[{ event: "reviewed", submitted_at: userReviewAt, user: { login: "example" } }]];
    await store.refresh();
    state = await store.change({ ids: ["2"], action: "file" });
    archivedAt = Date.parse(state.items.find(candidate => candidate.id === "2").filedAt);

    const replyAt = new Date(archivedAt + 1000).toISOString();
    data.pages[0][0].updated_at = replyAt;
    data.timeline = [[
        { event: "reviewed", submitted_at: userReviewAt, user: { login: "example" } },
        { event: "commented", created_at: replyAt, actor: { login: "reviewer" } },
    ]];
    state = await store.refresh();
    item = state.items.find(candidate => candidate.id === "2");
    assert.equal(item.filed, false);
    assert.equal(item.reason, "author");
    assert.equal(bucket(item), "needs");
    state = await store.refresh();
    assert.equal(bucket(state.items.find(candidate => candidate.id === "2")), "needs");
});

test("snoozed follow-up returns at its exact deadline", async t => {
    const { store } = await fixture(t);
    await store.refresh();
    await store.change({ ids: ["2"], action: "save" });
    const until = new Date(Date.now() + 100000).toISOString();
    const state = await store.change({ ids: ["2"], action: "snooze", until });
    const saved = state.items.find(item => item.id === "2");
    assert.equal(bucket(saved), "snoozed");
    assert.equal(bucket(saved, Date.parse(until)), "followup");
    await assert.rejects(store.change({ ids: ["2"], action: "snooze", until: "yesterday" }), /future/);
});

test("new activity clears snooze, but only new direct attention clears an archive", async t => {
    const { store, data } = await fixture(t);
    await store.refresh();
    const until = new Date(Date.now() + 100000).toISOString();
    await store.change({ ids: ["1"], action: "snooze", until });
    await store.change({ ids: ["2"], action: "file" });
    data.pages = [[notification("1", "mention", "2026-10-14T10:00:00Z")], [notification("2", "subscribed", "2026-10-14T10:00:00Z")]];
    let state = await store.refresh();
    assert.equal(state.items.find(item => item.id === "1").snoozedUntil, null);
    assert.equal(bucket(state.items.find(item => item.id === "1")), "needs");
    assert.equal(state.items.find(item => item.id === "2").filed, true);
    assert.equal(bucket(state.items.find(item => item.id === "2")), "filed");

    await store.change({ ids: ["1"], action: "save" });
    data.pages[0][0].updated_at = "2026-10-15T10:00:00Z";
    state = await store.refresh();
    const mentionedFollowup = state.items.find(item => item.id === "1");
    assert.equal(mentionedFollowup.saved, true);
    assert.equal(bucket(mentionedFollowup), "needs");
});

test("activity explanations identify matching PR approvals without returning comment text", async t => {
    const { store, data } = await fixture(t);
    data.pages[1][0] = notification("2", "author");
    data.timeline = [[
        { event: "reviewed", state: "approved", submitted_at: "2026-10-13T10:00:30Z", user: { login: "reviewer" }, body: "private review text" },
        { event: "commented", created_at: "2026-10-14T10:00:00Z", user: { login: "later" }, body: "later discussion" },
    ]];
    await store.refresh();
    const result = await store.explain("2");
    assert.equal(result.summary, "Approved by reviewer.");
    assert.equal(JSON.stringify(result).includes("private review text"), false);
    assert.equal(JSON.stringify(result).includes("later discussion"), false);
    await assert.rejects(store.explain("missing"), /no longer in the inbox/);
});

test("activity explanations include issue assignments", async t => {
    const { store, data } = await fixture(t);
    const issue = notification("85132", "assign", "2026-10-13T10:00:00Z");
    issue.subject = { title: "Issue 85132", type: "Issue", url: "https://api.github.com/repos/dotnet/roslyn/issues/85132" };
    data.pages = [[issue]];
    data.timeline = [[
        { event: "assigned", created_at: "2026-10-13T10:00:30Z", actor: { login: "reviewer" }, assignee: { login: "davidwengier" } },
    ]];
    await store.refresh();
    assert.equal((await store.explain("85132")).summary, "Assigned to davidwengier by reviewer.");
});

test("concurrent panels preserve independent local changes", async t => {
    const { store, directory, client, graphqlClient, createStore } = await fixture(t);
    await store.refresh();
    const other = createStore(directory, client, graphqlClient);
    await Promise.all([store.change({ ids: ["1"], action: "save" }), other.change({ ids: ["2"], action: "file" })]);
    const state = await store.snapshot();
    assert.equal(state.items[0].saved, true);
    assert.equal(state.items[1].filed, true);
});

test("account switches cannot mix saved follow-ups", async t => {
    const { store, data } = await fixture(t);
    await store.refresh();
    await store.change({ ids: ["1"], action: "save" });
    data.user = { id: 456, login: "second" };
    const state = await store.refresh();
    assert.equal(state.accountId, 456);
    assert.equal(state.items[0].saved, false);
});

test("view preferences survive store restarts and refreshes without crossing accounts", async t => {
    const { store, data, directory, client, graphqlClient, createStore } = await fixture(t);
    await store.refresh();
    await store.transaction(store.identity, state => {
        state.viewPreferences = { filters: { repo: "dotnet/razor", before: "2026-10-14" } };
    });
    for (const preference of [
        { activeTab: "following" },
        { filter: "search", value: "compiler" },
        { tab: "following", grouped: false },
        { tab: "following", repo: "dotnet/roslyn", expanded: true },
        { tab: "needs", repo: "dotnet/roslyn", expanded: false },
    ]) await store.setViewPreference(preference);

    const expected = {
        activeTab: "following",
        filters: { search: "compiler" },
        tabs: {
            following: { grouped: false, repositories: { "dotnet/roslyn": true } },
            needs: { repositories: { "dotnet/roslyn": false } },
        },
    };
    const restarted = createStore(directory, client, graphqlClient);
    assert.deepEqual((await restarted.snapshot()).viewPreferences, expected);
    assert.deepEqual((await restarted.refresh()).viewPreferences, expected);
    data.user = { id: 456, login: "second" };
    assert.equal((await restarted.refresh()).viewPreferences, undefined);
    data.user = { id: 123, login: "example" };
    assert.deepEqual((await restarted.refresh()).viewPreferences, expected);
});

test("invalid view preferences cannot change the saved state", async t => {
    const { store } = await fixture(t);
    const before = await store.refresh();
    for (const preference of [
        null, [], { activeTab: "unknown" }, { tab: "following", grouped: "false" },
        { tab: "following", repo: "../outside", expanded: true },
        { tab: "following", repo: "dotnet/roslyn", expanded: "true" },
        { filter: "__proto__", value: "invalid" }, { filter: "repo", value: "dotnet/roslyn" },
        { filter: "before", value: "2026-10-14" },
        { activeTab: "following", filter: "search", value: "mixed operations" },
    ]) await assert.rejects(store.setViewPreference(preference), /Invalid view preference/);
    assert.deepEqual(await store.snapshot(), before);
});

test("invalid batches and failed refreshes preserve the previous snapshot", async t => {
    const { store, data } = await fixture(t);
    const before = await store.refresh();
    await assert.rejects(store.change({ ids: ["1", "missing"], action: "file" }), /no longer exists/);
    data.pages = [[{ ...notification("3"), subject: {} }]];
    await assert.rejects(store.refresh(), /unsupported notification shape/);
    assert.deepEqual(await store.snapshot(), before);
});

test("HTTP serves assets, rejects cross-origin mutation and persists valid actions", async t => {
    const { store } = await fixture(t);
    await store.refresh();
    const opened = [];
    const entry = await startServer(store, async url => opened.push(url));
    t.after(() => new Promise(resolve => entry.server.close(resolve)));
    const origin = new URL(entry.url).origin;
    for (const file of ["", "app.js", "rules.mjs", "style.css", "state", "activity?id=2", "explain?id=2"]) {
        const response = await fetch(`${entry.url}${file}`);
        assert.equal(response.status, 200, file);
        const body = await response.text();
        if (file.startsWith("explain")) assert.match(body, /matching recent event/);
        if (file.startsWith("activity")) assert.match(body, /discovered/);
    }
    const rejected = await fetch(`${entry.url}change`, {
        method: "POST", headers: { Origin: "https://unrelated.example", "X-Triage-Request": "1" },
        body: JSON.stringify({ ids: ["1"], action: "save" }),
    });
    assert.equal(rejected.status, 403);
    const accepted = await fetch(`${entry.url}change`, {
        method: "POST", headers: { Origin: origin, "X-Triage-Request": "1" },
        body: JSON.stringify({ ids: ["1"], action: "save" }),
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).items[0].saved, true);
    const preferencesRejected = await fetch(`${entry.url}preferences`, {
        method: "POST", headers: { Origin: "https://unrelated.example", "X-Triage-Request": "1" },
        body: JSON.stringify({ activeTab: "following" }),
    });
    assert.equal(preferencesRejected.status, 403);
    const preferencesSaved = await fetch(`${entry.url}preferences`, {
        method: "POST", headers: { Origin: origin, "X-Triage-Request": "1" },
        body: JSON.stringify({ tab: "following", repo: "dotnet/roslyn", expanded: true }),
    });
    assert.equal(preferencesSaved.status, 200);
    assert.deepEqual(await preferencesSaved.json(), { saved: true });
    assert.equal((await store.snapshot()).viewPreferences.tabs.following.repositories["dotnet/roslyn"], true);
    const rejectedExternal = await fetch(`${entry.url}open`, {
        method: "POST", headers: { Origin: "https://unrelated.example", "X-Triage-Request": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://github.com/dotnet/roslyn/pull/42" }),
    });
    assert.equal(rejectedExternal.status, 403);
    assert.deepEqual(opened, []);
    const external = await fetch(`${entry.url}open`, {
        method: "POST", headers: { Origin: origin, "X-Triage-Request": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://github.com/dotnet/roslyn/pull/42" }),
    });
    assert.equal(external.status, 200);
    assert.deepEqual(opened, ["https://github.com/dotnet/roslyn/pull/42"]);
    const blocked = await fetch(`${entry.url}open`, {
        method: "POST", headers: { Origin: origin, "X-Triage-Request": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://evil.example/" }),
    });
    assert.equal(blocked.status, 400);
    assert.equal(opened.length, 1);
    assert.equal((await fetch(`${origin}/state`)).status, 404);
});
