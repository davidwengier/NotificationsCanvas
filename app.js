/* All remote text is rendered as textContent, never as executable markup. */
import { bucket, groupByRepository } from "./rules.mjs";
const $ = id => document.getElementById(id);
const names = { needs: "Needs me", following: "Following", followup: "Follow-up", snoozed: "Snoozed", filed: "Archived" };
const reasons = {
    assign: "You were assigned.",
    author: "GitHub marked an update to something you authored.",
    comment: "A comment was added to a thread you follow.",
    mention: "You were mentioned.",
    team_mention: "Your team was mentioned.",
    review_requested: "A review was requested from you.",
    manual: "You chose to follow this thread.",
    security_alert: "A security alert changed.",
};
const descriptions = {
    needs: "Rule-based: review requests, mentions, assignments, your own threads, manual subscriptions and security alerts. Not an AI judgement of urgency.",
    following: "Subscriptions, participation and other updates. Archiving removes an update from this panel only; new activity brings it back.",
    followup: "Explicitly saved threads, kept even after they leave GitHub's unread inbox. These are cached snapshots, not live issue or review status.",
    snoozed: "Hidden until the displayed time or until new activity arrives. Due items return to their normal view while this panel is open.",
    filed: "Updates you archived in this panel. They remain in GitHub; new activity brings the thread back here.",
};
let state = { items: [] };
let active = "needs";
let busy = false;
let visible = [];
const groupExpansion = new Map();
const groupingByTab = new Map();
let renderedGroups = [];
let preferenceWrites = Promise.resolve();

function applySnapshot(next) {
    const accountChanged = state.login !== next.login;
    state = next;
    if (accountChanged) {
        groupExpansion.clear();
        groupingByTab.clear();
        renderedGroups = [];
        const saved = next.viewPreferences ?? {};
        active = Object.hasOwn(names, saved.activeTab) ? saved.activeTab : "needs";
        $("search").value = saved.filters?.search ?? "";
        for (const [tab, preferences] of Object.entries(saved.tabs ?? {})) {
            if (!Object.hasOwn(names, tab)) continue;
            if (typeof preferences.grouped === "boolean") groupingByTab.set(tab, preferences.grouped);
            for (const [repo, expanded] of Object.entries(preferences.repositories ?? {})) {
                groupExpansion.set(JSON.stringify([tab, repo]), expanded);
            }
        }
    }
}

function savePreference(preference) {
    // Preserve the order of rapid toggles without letting saves rerender the page.
    preferenceWrites = preferenceWrites.then(() => request("preferences", preference)).catch(error => {
        $("error").textContent = error.message;
        $("error").hidden = false;
    });
    return preferenceWrites;
}

function rememberExpansion(key, expanded) {
    if (groupExpansion.get(key) === expanded) return;
    groupExpansion.set(key, expanded);
    const [tab, repo] = JSON.parse(key);
    return savePreference({ tab, repo, expanded });
}

function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}

async function request(route, body) {
    const response = await fetch(route, body === undefined ? {} : {
        method: "POST", headers: { "Content-Type": "application/json", "X-Triage-Request": "1" },
        body: JSON.stringify(body), keepalive: route === "preferences",
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
}

async function perform(operation) {
    if (busy) return;
    busy = true;
    $("error").hidden = true;
    render();
    try {
        applySnapshot(await operation());
    } catch (error) {
        $("error").textContent = error.message;
        $("error").hidden = false;
    } finally {
        busy = false;
        render();
    }
}

function change(item, action, extra = {}) {
    return perform(() => request("change", { ids: [item.id], action, ...extra }));
}

function button(text, action) {
    const node = element("button", text);
    node.disabled = busy;
    node.addEventListener("click", action);
    return node;
}

function statusIcon(item) {
    const labels = {
        Issue: {
            open: "Open issue", completed: "Completed issue", not_planned: "Issue closed as not planned",
            duplicate: "Duplicate issue", closed: "Closed issue", unknown: "Issue status unavailable",
        },
        PullRequest: {
            open: "Open pull request", draft: "Draft pull request", closed: "Closed pull request",
            merged: "Merged pull request", unknown: "Pull request status unavailable",
        },
    };
    const label = labels[item.type]?.[item.status] ?? labels[item.type]?.unknown;
    if (!label) return null;

    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const closedClass = item.status === "closed" ? (item.type === "PullRequest" ? "closed-pr" : "closed-issue") : item.status;
    icon.setAttribute("class", `status-icon status-icon--${closedClass}`);
    icon.setAttribute("viewBox", "0 0 16 16");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("title", label);
    if (item.type === "Issue") {
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", "8");
        circle.setAttribute("cy", "8");
        circle.setAttribute("r", "6.25");
        icon.append(circle);
        const mark = document.createElementNS("http://www.w3.org/2000/svg", "path");
        const path = item.status === "completed" ? "m5 8 2 2 4-4"
            : item.status === "not_planned" ? "M5 8h6"
                : item.status === "duplicate" || item.status === "closed" ? "m6 6 4 4m0-4-4 4"
                    : "M8 5v3.5m0 2.5v.01";
        mark.setAttribute("d", path);
        icon.append(mark);
    } else {
        const branch = document.createElementNS("http://www.w3.org/2000/svg", "path");
        branch.setAttribute("d", "M5 3v10m0-5h5a2 2 0 0 0 2-2V4");
        icon.append(branch);
        for (const [cx, cy] of [["5", "3"], ["5", "13"], ["12", "4"]]) {
            const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            circle.setAttribute("cx", cx);
            circle.setAttribute("cy", cy);
            circle.setAttribute("r", "1.5");
            icon.append(circle);
        }
    }
    return { icon, label };
}

function card(item) {
    const article = element("article");
    const history = element("ol", undefined, "activity-history");
    history.hidden = true;
    let historyLoaded = false;
    const historyButton = button("History", async () => {
        const wasHidden = history.hidden;
        history.hidden = !history.hidden;
        historyButton.setAttribute("aria-expanded", String(!history.hidden));
        if (!wasHidden || historyLoaded) return;
        history.replaceChildren(element("li", "Loading activity history..."));
        try {
            const events = await request(`activity?id=${encodeURIComponent(item.id)}`);
            history.replaceChildren();
            if (!events.length) history.append(element("li", "No history recorded yet."));
            for (const event of events) {
                const source = {
                    github: "GitHub", github_observation: "GitHub inbox observation",
                    local_user: "You", local_rule: "Automatic rule", local_migration: "Local migration",
                }[event.source] ?? event.source;
                const occurredAt = new Date(event.occurredAt).toLocaleString();
                const observedAt = event.observedAt && event.observedAt !== event.occurredAt
                    ? ` · noticed ${new Date(event.observedAt).toLocaleString()}` : "";
                history.append(element("li", `${event.summary} — ${source} · ${occurredAt}${observedAt}`));
            }
            historyLoaded = true;
        } catch (error) {
            history.replaceChildren(element("li", `Could not load activity history: ${error.message}`));
        }
    });
    historyButton.classList.add("history-button");
    historyButton.setAttribute("aria-expanded", "false");
    const number = item.number || /\/(?:pull|issues)\/(\d+)$/.exec(item.url)?.[1];
    const link = element("a", number ? `${item.title} (#${number})` : item.title);
    const status = statusIcon(item);
    if (status) {
        link.setAttribute("aria-label", `${status.label}: ${link.textContent}`);
        link.prepend(status.icon);
    }
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    // Use the OS browser for normal clicks, but leave modified clicks as native links.
    link.addEventListener("click", event => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        request("open", { url: item.url }).catch(error => {
            $("error").textContent = error.message;
            $("error").hidden = false;
        });
    });
    article.append(link, historyButton);
    const reason = (item.reason || "unknown").replaceAll("_", " ");
    const repository = $("group-by-repo").checked ? "" : `${item.repo} · `;
    const readState = item.inGithubNotifications === false ? " · not returned by GitHub; kept locally" :
        item.inUnread ? "" : " · read on GitHub";
    const metadata = `${repository}${item.type} · ${reason} · updated ${new Date(item.updatedAt).toLocaleString()}${readState}${item.snoozedUntil ? ` · snoozed until ${new Date(item.snoozedUntil).toLocaleString()}` : ""}`;
    article.append(element("p", metadata, "meta"));
    if (active === "needs") {
        const why = element("p", reasons[item.reason] || `GitHub marked it as ${reason}.`, "why");
        article.append(why);
    }
    // Recent activity helps with both actionable PRs and general updates being followed.
    if ((active === "needs" || active === "following") && (item.type === "PullRequest" || item.type === "Issue")) {
        const row = element("div", undefined, "activity");
        const details = element("span", item.recentActivity || "No timeline activity found.");
        details.setAttribute("aria-live", "polite");
        const check = button("", async () => {
            check.disabled = true;
            check.setAttribute("aria-busy", "true");
            try {
                const result = await request(`explain?id=${encodeURIComponent(item.id)}`);
                details.textContent = result.summary;
            } catch (error) {
                $("error").textContent = error.message;
                $("error").hidden = false;
            } finally {
                check.disabled = busy;
                check.setAttribute("aria-busy", "false");
            }
        });
        check.classList.add("activity-check");
        check.setAttribute("aria-label", "Refresh recent activity");
        check.title = "Refresh recent activity";
        const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        icon.setAttribute("viewBox", "0 0 24 24");
        icon.setAttribute("aria-hidden", "true");
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", "M20 11a8 8 0 1 0-2 6M20 4v7h-7");
        icon.append(path);
        check.append(icon);
        row.append(element("span", "Recent activity:"), details, check);
        article.append(row);
    }
    const actions = element("div", undefined, "actions");
    actions.append(button(item.saved ? "Remove follow-up" : "Keep for follow-up", () => change(item, item.saved ? "unsave" : "save")));
    if (bucket(item) === "snoozed") {
        actions.append(button("Wake now", () => change(item, "wake")));
    } else {
        actions.append(button("Snooze 1 day", () => change(item, "snooze", { until: new Date(Date.now() + 86400000).toISOString() })));
        actions.append(button("Snooze 1 week", () => change(item, "snooze", { until: new Date(Date.now() + 7 * 86400000).toISOString() })));
    }
    if (item.filed) actions.append(button("Show again", () => change(item, "restore")));
    else if (!item.saved) actions.append(button("Archive", () => change(item, "file")));
    article.append(actions);
    if (item.saved || item.note) {
        const row = element("div", undefined, "note");
        const input = element("input");
        input.value = item.note || "";
        input.maxLength = 4000;
        input.placeholder = "What am I waiting for?";
        input.setAttribute("aria-label", `Follow-up note for ${item.title}`);
        row.append(input, button("Save note", () => change(item, "note", { note: input.value })));
        article.append(row);
    }
    article.append(history);
    return article;
}

function render() {
    // Read the actual DOM state before replacing groups; toggle events can arrive
    // after a render, and the active tab may already have changed.
    for (const [key, details] of renderedGroups) rememberExpansion(key, details.open);
    renderedGroups = [];
    // Grouping is a view preference, not a setting shared between tabs.
    $("group-by-repo").checked = groupingByTab.get(active) ?? true;
    $("refresh").disabled = busy;
    $("refresh").textContent = busy ? "Working..." : "Refresh GitHub";
    $("status").textContent = state.lastRefresh
        ? `${state.login} · ${state.unreadCount} unread on GitHub at last refresh · ${new Date(state.lastRefresh).toLocaleString()}`
        : "No snapshot yet. Refresh GitHub to fetch your notifications.";
    $("tabs").replaceChildren();
    for (const [key, name] of Object.entries(names)) {
        const count = state.items.filter(item => bucket(item) === key).length;
        const tab = button(`${name} (${count})`, () => {
            active = key;
            const saved = savePreference({ activeTab: key });
            render();
            return saved;
        });
        tab.setAttribute("aria-pressed", String(active === key));
        $("tabs").append(tab);
    }
    const search = $("search").value.toLowerCase();
    visible = state.items.filter(item => bucket(item) === active &&
        `${item.title} ${item.repo} ${item.note || ""}`.toLowerCase().includes(search))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    $("summary").textContent = `${visible.length} displayed`;
    $("file-visible").hidden = active !== "following" || visible.length === 0;
    $("file-visible").disabled = busy || visible.length > 1000;
    $("explanation").textContent = descriptions[active];
    $("items").replaceChildren();
    const grouped = $("group-by-repo").checked;
    $("items").classList.toggle("ungrouped", !grouped && visible.length > 0);
    if (!visible.length) $("items").append(element("p", "Nothing here with these filters.", "empty"));
    if (!grouped) {
        for (const item of visible) $("items").append(card(item));
        return;
    }
    const groups = groupByRepository(visible);
    for (const [repo, items] of groups) {
        const details = element("details");
        const key = JSON.stringify([active, repo]);
        // Defaults apply only on first appearance, never over a remembered choice.
        if (!groupExpansion.has(key)) rememberExpansion(key, active !== "following" || groups.length === 1);
        details.open = groupExpansion.get(key);
        renderedGroups.push([key, details]);
        details.addEventListener("toggle", () => {
            // Delayed events from replaced groups must not overwrite newer choices.
            if (renderedGroups.some(([, node]) => node === details)) {
                return rememberExpansion(key, details.open);
            }
        });
        details.append(element("summary", `${repo} (${items.length})`));
        for (const item of items) details.append(card(item));
        $("items").append(details);
    }
}

$("refresh").addEventListener("click", () => perform(() => request("refresh", {})));
for (const id of ["search"]) $(id).addEventListener("input", () => {
    const saved = savePreference({ filter: id, value: $(id).value });
    render();
    return saved;
});
$("group-by-repo").addEventListener("change", () => {
    const grouped = $("group-by-repo").checked;
    groupingByTab.set(active, grouped);
    const saved = savePreference({ tab: active, grouped });
    render();
    return saved;
});
$("file-visible").addEventListener("click", () => {
    const ids = visible.map(item => item.id);
    if (confirm(`Archive these ${ids.length} updates in this panel? GitHub stays unchanged, and you can find them under Archived and show them again.`)) {
        perform(() => request("change", { ids, action: "file" }));
    }
});
// Re-evaluate snooze deadlines locally; refresh periodically while this panel is open
// so new GitHub activity is not hidden behind a stale snapshot.
setInterval(() => {
    if (!busy) {
        if (document.visibilityState === "visible") perform(() => request("refresh", {}));
        else render();
    }
}, 10 * 60 * 1000);
perform(async () => {
    applySnapshot(await request("state"));
    render();
    return request("refresh", {});
});
