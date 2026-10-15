// Personal triage stays local; all GitHub calls, including GraphQL status queries, are read-only.
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import { fileURLToPath } from "node:url";
import { TriageStore } from "./store.mjs";
import { startServer } from "./server.mjs";

const store = new TriageStore(fileURLToPath(new URL("./artifacts/", import.meta.url)));
const servers = new Map();

await joinSession({
    canvases: [createCanvas({
        id: "notification-triage",
        displayName: "GitHub notification triage",
        description: "Read-only GitHub inbox with optional repository grouping, follow-up, snoozing, and local archiving.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        actions: [
            {
                name: "refresh",
                description: "Fetch unread notifications and issue/PR statuses without changing anything on GitHub.",
                handler: async () => {
                    const state = await store.refresh();
                    return { login: state.login, unread: state.unreadCount, lastRefresh: state.lastRefresh };
                },
            },
            {
                name: "snapshot",
                description: "Read the locally cached triage state, including saved follow-ups.",
                handler: () => store.snapshot(),
            },
        ],
        open: async (ctx) => {
            let entry = servers.get(ctx.instanceId);
            if (!entry) {
                entry = await startServer(store);
                servers.set(ctx.instanceId, entry);
            }
            return { title: "GitHub notification triage", url: entry.url };
        },
        onClose: async (ctx) => {
            const entry = servers.get(ctx.instanceId);
            if (entry) {
                servers.delete(ctx.instanceId);
                await new Promise((resolve, reject) => entry.server.close(error => error ? reject(error) : resolve()));
            }
        },
    })],
});
