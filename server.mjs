import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

function validateGithubUrl(value) {
    if (typeof value !== "string") throw new TypeError("A GitHub URL is required.");
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new TypeError("The link is not a valid URL.");
    }
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password) {
        throw new TypeError("Only https://github.com links can be opened externally.");
    }
    return url.href;
}

function openInDefaultBrowser(url) {
    // Delegate to the OS so the user's configured browser handles GitHub links.
    const [command, args] = process.platform === "win32"
        ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
        : process.platform === "darwin"
            ? ["open", [url]]
            : ["xdg-open", [url]];
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
        child.once("error", reject);
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
    });
}

export async function startServer(store, openExternal = openInDefaultBrowser) {
    const token = randomBytes(24).toString("hex");
    const prefix = `/${token}/`;
    let origin;
    const server = createServer(async (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'");
        const send = (status, body) => {
            res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(body));
        };
        try {
            if (req.headers.host !== new URL(origin).host || !req.url?.startsWith(prefix)) return send(404, { error: "Not found." });
            const requestUrl = new URL(req.url, origin);
            const route = requestUrl.pathname.slice(prefix.length);
            if (req.method === "GET" && ["", "app.js", "rules.mjs", "style.css"].includes(route)) {
                const asset = route || "index.html";
                const content = await readFile(new URL(`./${asset}`, import.meta.url));
                res.writeHead(200, { "Content-Type": /\.(m?js)$/.test(asset) ? "text/javascript; charset=utf-8" : asset.endsWith(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8" });
                return res.end(content);
            }
            if (req.method === "GET" && route === "state") return send(200, await store.snapshot());
            if (req.method === "GET" && route === "activity") {
                return send(200, await store.activity(requestUrl.searchParams.get("id")));
            }
            if (req.method === "GET" && route === "explain") return send(200, await store.explain(requestUrl.searchParams.get("id")));
            if (req.method !== "POST" || !["refresh", "change", "open", "preferences"].includes(route)) return send(404, { error: "Not found." });
            // A random path, exact Host/Origin checks and a custom header keep
            // unrelated websites from driving authenticated local operations.
            if (req.headers.origin !== origin || req.headers["x-triage-request"] !== "1") return send(403, { error: "Request origin rejected." });
            let body = "";
            for await (const chunk of req) {
                body += chunk.toString();
                if (Buffer.byteLength(body) > 65536) return send(413, { error: "Request is too large." });
            }
            const payload = route === "refresh" ? {} : JSON.parse(body);
            if (route === "preferences") {
                await store.setViewPreference(payload);
                return send(200, { saved: true });
            }
            if (route === "open") {
                let url;
                try {
                    url = validateGithubUrl(payload.url);
                } catch (error) {
                    return send(400, { error: error.message });
                }
                await openExternal(url);
                return send(200, { opened: true });
            }
            const result = route === "refresh" ? await store.refresh() : await store.change(payload);
            send(200, result);
        } catch (error) {
            send(500, { error: error.message });
        }
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    return { server, url: `${origin}${prefix}` };
}
