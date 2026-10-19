import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { bucket, groupByRepository } from "./rules.mjs";

// Run the real renderer without a browser or GitHub; open is the native details state.
class Element {
    constructor(tag) {
        this.tag = tag;
        this.children = [];
        this.listeners = new Map();
        this.value = "";
        this.open = false;
        this.classList = {
            add: (...names) => { this.className = [...new Set([...(this.className || "").split(" ").filter(Boolean), ...names])].join(" "); },
            toggle() {},
        };
    }
    append(...children) { this.children.push(...children); }
    prepend(child) { this.children.unshift(child); }
    replaceChildren(...children) { this.children = children; }
    add(child) { this.append(child); }
    setAttribute(name, value) {
        this[name] = value;
        if (name === "class") this.className = value;
    }
    addEventListener(name, handler) { this.listeners.set(name, handler); }
    fire(name) { return this.listeners.get(name)?.({}); }
}

async function fixture(previousSnapshot) {
    const tabs = {
        needs: "Needs me", following: "Following", followup: "Follow-up",
        snoozed: "Snoozed", filed: "Archived",
    };
    const snapshot = previousSnapshot ?? { login: "example", items: [] };
    for (const tab of previousSnapshot ? [] : Object.keys(tabs)) {
        for (const repo of ["dotnet/razor", "dotnet/roslyn"]) {
            for (let number = 1; number <= 2; number++) {
                snapshot.items.push({
                    id: `${tab}-${repo}-${number}`, repo, title: `Thread ${number}`, type: "Issue",
                    url: `https://github.com/${repo}/issues/${number}`, updatedAt: "2026-10-13T10:00:00Z",
                    status: number === 1 ? "open" : "completed",
                    recentActivity: "Comment added by reviewer.",
                    reason: tab === "needs" ? "mention" : "subscribed",
                    saved: tab === "followup", filed: tab === "filed", inUnread: true,
                    snoozedUntil: tab === "snoozed" ? "2099-01-01T00:00:00Z" : null,
                });
            }
        }
    }
    const elements = new Map();
    const get = id => {
        if (!elements.has(id)) elements.set(id, new Element("div"));
        return elements.get(id);
    };
    get("group-by-repo").checked = true;
    const clock = { now: Date.parse("2026-10-15T12:00:00Z") };
    const intervals = [];
    const context = createContext({
        bucket, groupByRepository, setInterval: (callback, ms) => intervals.push({ callback, ms }),
        Date: class extends Date {
            constructor(...args) { super(...(args.length ? args : [clock.now])); }
            static now() { return clock.now; }
        },
        document: { getElementById: get, createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag) },
        Option: class extends Element {},
        fetch: async (route, options) => {
            if (route === "preferences") {
                const { tab, grouped, repo, expanded, activeTab, filter, value } = JSON.parse(options.body);
                snapshot.viewPreferences ??= {};
                if (activeTab !== undefined) snapshot.viewPreferences.activeTab = activeTab;
                else if (filter !== undefined) (snapshot.viewPreferences.filters ??= {})[filter] = value;
                else {
                    snapshot.viewPreferences.tabs ??= {};
                    const preferences = snapshot.viewPreferences.tabs[tab] ??= {};
                    if (grouped !== undefined) preferences.grouped = grouped;
                    if (repo !== undefined) (preferences.repositories ??= {})[repo] = expanded;
                }
                return { ok: true, json: async () => ({ saved: true }) };
            }
            if (route === "change") {
                const { ids, action } = JSON.parse(options.body);
                assert.equal(action, "file");
                for (const item of snapshot.items) if (ids.includes(item.id)) item.filed = true;
            }
            if (route.startsWith("activity?")) {
                return {
                    ok: true,
                    json: async () => [{
                        eventType: "discovered", source: "github", summary: "Discovered in GitHub notifications.",
                        occurredAt: "2026-10-13T10:00:00Z", observedAt: "2026-10-15T10:00:00Z",
                    }],
                };
            }
            return { ok: true, json: async () => structuredClone(snapshot) };
        },
    });
    const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
    runInContext(source.replace(/^import .* from "\.\/rules\.mjs";\r?\n/m, ""), context);
    await new Promise(resolve => setImmediate(resolve));
    return {
        get, hasElement: id => elements.has(id), snapshot, tabs, clock, intervals,
        select: tab => get("tabs").children.find(button => button.textContent.startsWith(`${tabs[tab]} (`)).fire("click"),
        groups: () => get("items").children.filter(node => node.tag === "details"),
        activityTexts: () => get("items").children.flatMap(group => (group.children ?? [])
            .filter(article => article.tag === "article")
            .map(article => article.children.find(node => node.className === "activity")?.children[1]?.textContent)
            .filter(Boolean)),
        refresh: () => get("refresh").fire("click"),
        settle: () => new Promise(resolve => setImmediate(resolve)),
    };
}

test("a fresh page restores independent grouping and expansion for every tab", async () => {
    const ui = await fixture();
    const tabs = Object.keys(ui.tabs);
    for (const [index, tab] of tabs.entries()) {
        ui.select(tab);
        for (const [groupIndex, group] of ui.groups().entries()) {
            group.open = groupIndex === index % 2;
            await group.fire("toggle");
        }
        ui.get("group-by-repo").checked = index % 2 === 0;
        await ui.get("group-by-repo").fire("change");
    }
    await ui.settle();

    // A new JavaScript context models reloading the extension, not just rerendering it.
    const reopened = await fixture(ui.snapshot);
    for (const [index, tab] of tabs.entries()) {
        reopened.select(tab);
        assert.equal(reopened.get("group-by-repo").checked, index % 2 === 0, `${tab} grouping`);
        if (index % 2 !== 0) {
            reopened.get("group-by-repo").checked = true;
            await reopened.get("group-by-repo").fire("change");
        }
        assert.deepEqual(reopened.groups().map(group => group.open),
            [index % 2 === 0, index % 2 !== 0], `${tab} expansion`);
    }
});

test("a fresh page restores the active tab and search filter without removed filters", async () => {
    const ui = await fixture();
    await ui.select("following");
    ui.get("search").value = "Thread 1";
    await ui.get("search").fire("input");
    await ui.settle();
    ui.snapshot.viewPreferences.filters.repo = "dotnet/razor";
    ui.snapshot.viewPreferences.filters.before = "2026-10-14";
    const reopened = await fixture(ui.snapshot);
    assert.equal(reopened.get("tabs").children.find(tab => tab["aria-pressed"] === "true").textContent.startsWith("Following"), true);
    assert.equal(reopened.get("search").value, "Thread 1");
    assert.equal(reopened.hasElement("repo"), false);
    assert.equal(reopened.hasElement("before"), false);
    assert.equal(reopened.groups().length, 2);
    assert.ok(reopened.groups().every(group => group.children.filter(node => node.tag === "article").length === 1));
});

test("delayed toggles from replaced groups cannot overwrite persisted expansion", async () => {
    const ui = await fixture();
    await ui.select("following");
    const oldGroup = ui.groups()[0];
    oldGroup.open = true;
    await oldGroup.fire("toggle");
    await ui.refresh();
    oldGroup.open = false;
    await oldGroup.fire("toggle");
    await ui.settle();
    const reopened = await fixture(ui.snapshot);
    assert.equal(reopened.groups()[0].open, true);
});

test("Needs me and Following cards show cached recent activity immediately", async () => {
    const ui = await fixture();
    assert.ok(ui.activityTexts().length > 0);
    assert.ok(ui.activityTexts().every(text => text === "Comment added by reviewer."));
    ui.select("following");
    assert.ok(ui.activityTexts().length > 0);
    assert.ok(ui.activityTexts().every(text => text === "Comment added by reviewer."));
});

test("cards can show an item's persisted activity history", async () => {
    const ui = await fixture();
    const article = ui.groups()[0].children.find(node => node.tag === "article");
    const historyButton = article.children.find(button => button.textContent === "History");
    const history = article.children.find(node => node.className === "activity-history");
    assert.equal(historyButton.className, "history-button");
    assert.equal(history.hidden, true);
    await historyButton.fire("click");
    assert.equal(history.hidden, false);
    assert.equal(historyButton["aria-expanded"], "true");
    assert.match(history.children[0].textContent, /Discovered in GitHub notifications/);
    assert.match(history.children[0].textContent, /noticed/);
});

test("every tab keeps repository expansion through refresh, filters and grouping changes", async () => {
    const ui = await fixture();
    for (const tab of Object.keys(ui.tabs)) {
        ui.select(tab);
        ui.groups()[0].open = true;
        ui.groups()[1].open = false;
        await ui.refresh();
        assert.deepEqual(ui.groups().map(group => group.open), [true, false], tab);
        ui.get("search").value = "razor";
        ui.get("search").fire("input");
        ui.get("search").value = "";
        ui.get("search").fire("input");
        ui.get("group-by-repo").checked = false;
        ui.get("group-by-repo").fire("change");
        ui.get("group-by-repo").checked = true;
        ui.get("group-by-repo").fire("change");
        assert.deepEqual(ui.groups().map(group => group.open), [true, false], tab);
    }
});

test("tabs remember independent repository expansion choices", async () => {
    const ui = await fixture();
    const tabs = Object.keys(ui.tabs);
    for (const [index, tab] of tabs.entries()) {
        ui.select(tab);
        ui.groups()[0].open = index % 2 === 0;
        ui.groups()[1].open = index % 2 !== 0;
    }
    for (const [index, tab] of tabs.entries()) {
        ui.select(tab);
        assert.deepEqual(ui.groups().map(group => group.open), [index % 2 === 0, index % 2 !== 0], tab);
    }
});

test("each tab remembers grouping independently without losing repository expansion", async () => {
    const ui = await fixture();
    const tabs = Object.keys(ui.tabs);
    for (const [index, tab] of tabs.entries()) {
        ui.select(tab);
        assert.equal(ui.get("group-by-repo").checked, true, `${tab} defaults to grouped`);
        ui.groups()[0].open = index % 2 === 0;
        ui.groups()[1].open = index % 2 !== 0;
        ui.get("group-by-repo").checked = index % 2 === 0;
        ui.get("group-by-repo").fire("change");
    }
    for (const [index, tab] of tabs.entries()) {
        ui.select(tab);
        await ui.refresh();
        assert.equal(ui.get("group-by-repo").checked, index % 2 === 0, tab);
        if (index % 2 !== 0) assert.equal(ui.groups().length, 0, tab);
        ui.get("group-by-repo").checked = true;
        ui.get("group-by-repo").fire("change");
        assert.deepEqual(ui.groups().map(group => group.open), [index % 2 === 0, index % 2 !== 0], tab);
        ui.get("group-by-repo").checked = index % 2 === 0;
        ui.get("group-by-repo").fire("change");
    }
});

test("cards show status icons with accessible labels and status colors", async () => {
    const ui = await fixture();
    const [repository] = ui.groups();
    const [openArticle, completedArticle] = repository.children.filter(node => node.tag === "article");
    const openLink = openArticle.children[0];
    const completedLink = completedArticle.children[0];
    assert.equal(openLink.children[0].className, "status-icon status-icon--open");
    assert.equal(openLink["aria-label"], "Open issue: Thread 1 (#1)");
    assert.equal(completedLink.children[0].className, "status-icon status-icon--completed");
    assert.equal(completedLink["aria-label"], "Completed issue: Thread 2 (#2)");
});

test("archiving and changing the number of Following groups do not override expansion", async () => {
    const ui = await fixture();
    ui.select("following");
    ui.groups()[0].open = true;
    ui.groups()[1].open = false;
    const article = ui.groups()[0].children.find(node => node.tag === "article");
    const actions = article.children.find(node => node.className === "actions");
    await actions.children.find(button => button.textContent === "Archive").fire("click");
    assert.deepEqual(ui.groups().map(group => group.open), [true, false]);
    ui.snapshot.items = ui.snapshot.items.filter(item => item.repo !== "dotnet/razor");
    await ui.refresh();
    assert.deepEqual(ui.groups().map(group => group.open), [false]);
});

test("the refresh time turns red after ten minutes and the timer never refreshes GitHub", async () => {
    const ui = await fixture();
    ui.snapshot.lastRefresh = "2026-10-15T11:50:00Z";
    await ui.refresh();
    await ui.settle();

    // Exactly ten minutes old is still fresh.
    assert.equal(ui.get("status").className, "");
    assert.doesNotMatch(ui.get("status").textContent, /out of date/);

    ui.clock.now += 1000;
    const timer = ui.intervals.at(-1);
    timer.callback();
    assert.equal(ui.get("status").className, "stale");
    assert.match(ui.get("status").textContent, /out of date/);
    assert.ok(timer.ms < 10 * 60 * 1000);

    // Refreshing stores a new time, which clears the warning.
    ui.snapshot.lastRefresh = new Date(ui.clock.now).toISOString();
    await ui.refresh();
    await ui.settle();
    assert.equal(ui.get("status").className, "");
});
