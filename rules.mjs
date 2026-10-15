const directReasons = new Set(["assign", "author", "mention", "team_mention", "review_requested", "manual", "security_alert"]);
export const rulesVersion = 1;

export function needsAttention(reason) {
    return directReasons.has(reason);
}

export function classify(item, now = Date.now()) {
    if (item.snoozedUntil && Date.parse(item.snoozedUntil) > now) {
        return { bucket: "snoozed", rule: "snoozed", explanation: `Snoozed until ${item.snoozedUntil}.` };
    }
    // Archives stay put until refresh finds a direct attention event newer than the archive.
    if (item.filed) return { bucket: "filed", rule: "archived", explanation: "The local archive still applies." };
    // GitHub keeps the review_requested reason after a PR is merged or closed,
    // but there is nothing left to review, so don't treat it as needing attention.
    const reviewNoLongerNeeded = item.reason === "review_requested" && item.prState && item.prState !== "open";
    if (needsAttention(item.reason) && !reviewNoLongerNeeded) {
        return { bucket: "needs", rule: "direct_attention", explanation: `Attention reason: ${item.reason.replaceAll("_", " ")}.` };
    }
    if (item.saved) return { bucket: "followup", rule: "saved", explanation: "Kept for follow-up, with no current direct attention reason." };
    return {
        bucket: "following",
        rule: reviewNoLongerNeeded ? "review_no_longer_needed" : "general_update",
        explanation: reviewNoLongerNeeded ? "The pull request is no longer open for review." : "There is no direct attention reason.",
    };
}

export function bucket(item, now = Date.now()) {
    return classify(item, now).bucket;
}

export function groupByRepository(items) {
    const groups = new Map();
    for (const item of items) {
        if (!groups.has(item.repo)) groups.set(item.repo, []);
        groups.get(item.repo).push(item);
    }
    // Group positions must not change when the newest item is archived.
    return [...groups].sort(([left], [right]) => left.localeCompare(right));
}
