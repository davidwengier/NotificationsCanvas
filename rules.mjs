const directReasons = new Set(["assign", "author", "mention", "team_mention", "review_requested", "manual", "security_alert"]);

export function needsAttention(reason) {
    return directReasons.has(reason);
}

export function bucket(item, now = Date.now()) {
    if (item.snoozedUntil && Date.parse(item.snoozedUntil) > now) return "snoozed";
    // Archives stay put until refresh finds a direct attention event newer than the archive.
    if (item.filed) return "filed";
    // GitHub keeps the review_requested reason after a PR is merged or closed,
    // but there is nothing left to review, so don't treat it as needing attention.
    const reviewNoLongerNeeded = item.reason === "review_requested" && item.prState && item.prState !== "open";
    if (needsAttention(item.reason) && !reviewNoLongerNeeded) return "needs";
    if (item.saved) return "followup";
    return "following";
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
