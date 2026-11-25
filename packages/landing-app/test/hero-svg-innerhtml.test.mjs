/*
 * Copyright 2026 Palantir Technologies, Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Hero SVGs are bundled with raw-loader and assigned with innerHTML.
 * These tests fail while that markup can execute in the landing page.
 *
 * Versions match pnpm-lock.yaml for the landing-app production bundle:
 * webpack 5.102.1, raw-loader 4.0.2, swc-loader 0.2.6, @swc/core 1.13.20,
 * terser-webpack-plugin 5.3.14.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const svgSourceDir = path.join(repoRoot, "packages/landing-app/src/svgs");
const indexSourcePath = path.join(svgSourceDir, "index.ts");

const TOOLCHAIN_PACKAGES = {
    webpack: "5.102.1",
    "raw-loader": "4.0.2",
    "swc-loader": "0.2.6",
    "@swc/core": "1.13.20",
    "terser-webpack-plugin": "5.3.14",
};

const SVG_IDS = [
    "alert",
    "buttons",
    "calendar",
    "checkboxes",
    "file-upload",
    "input-groups",
    "inputs",
    "labels",
    "radios",
    "select-menus",
    "sliders",
    "switches",
    "time-selections",
    "toggles",
];

function flagName(id) {
    return `__ran_${id.replace(/-/g, "_")}`;
}

function flagAssignment(id) {
    return `window.${flagName(id)}=1`;
}

/** Markup an attacker can place in one of the hero SVG files. */
function payloadFor(id) {
    const flag = flagAssignment(id);
    switch (id) {
        case "alert":
            return `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><foreignObject width="12" height="12"><img src="x" onerror="${flag}"></foreignObject></svg>`;
        case "buttons":
            return `<svg xmlns="http://www.w3.org/2000/svg" onload="${flag}"></svg>`;
        case "calendar":
            return `<svg xmlns="http://www.w3.org/2000/svg"><image href="x" onerror="${flag}"></image></svg>`;
        case "checkboxes":
            return `<img src="x" onerror="${flag}">`;
        case "file-upload":
            return `<iframe srcdoc="<img src=x onerror=parent.${flagName(id)}=1>"></iframe>`;
        case "input-groups":
            return `<math><mi><img src="x" onerror="${flag}"></mi></math>`;
        case "inputs":
            return `<svg xmlns="http://www.w3.org/2000/svg"><script>${flag}</script></svg>`;
        case "labels":
            return `<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:${flag}"><text>x</text></a></svg>`;
        case "radios":
            return `<svg xmlns="http://www.w3.org/2000/svg" OnLoAd="${flag}"></svg>`;
        case "select-menus":
            return `<img src="x" onerror="${flag}">`;
        case "sliders":
            return `<svg xmlns="http://www.w3.org/2000/svg"><script href="data:text/javascript,${encodeURIComponent(flag)}"></script></svg>`;
        case "switches":
            return `<object data="javascript:${flag}"></object>`;
        case "time-selections":
            return `<embed src="javascript:${flag}">`;
        case "toggles":
            return `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="8" height="8"><body xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="${flag}"></body></foreignObject></svg>`;
        default:
            throw new Error(`No payload for hero SVG id ${id}`);
    }
}

function heroIdsFromSource(source) {
    const ids = [];
    const pattern = /^\s+(?:"([^"]+)"|([A-Za-z0-9-]+)):\s*require\("raw-loader!/gm;
    for (const match of source.matchAll(pattern)) {
        ids.push(match[1] ?? match[2]);
    }
    return ids;
}

async function ensureToolchain(toolchainDir) {
    const marker = path.join(toolchainDir, "installed.json");
    const expected = JSON.stringify(TOOLCHAIN_PACKAGES);
    try {
        if ((await readFile(marker, "utf8")) === expected) {
            return;
        }
    } catch {
        // install below
    }
    await rm(toolchainDir, { recursive: true, force: true });
    await mkdir(toolchainDir, { recursive: true });
    await writeFile(
        path.join(toolchainDir, "package.json"),
        JSON.stringify({ private: true, dependencies: TOOLCHAIN_PACKAGES }, null, 4),
    );
    await runCommand("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"], toolchainDir);
    await runCommand("npm", ["rebuild", "@swc/core"], toolchainDir);
    await writeFile(marker, expected);
}

function runCommand(command, args, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        child.stderr.on("data", chunk => {
            stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", code => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${stderr}`));
            }
        });
    });
}

async function buildLandingBundle(workDir, toolchainDir) {
    const requireFromToolchain = createRequire(path.join(toolchainDir, "package.json"));
    const webpack = requireFromToolchain("webpack");
    const TerserPlugin = requireFromToolchain("terser-webpack-plugin");
    const swcLoader = requireFromToolchain.resolve("swc-loader");

    const harnessPath = path.join(workDir, "src/harness.ts");
    // Same call site as packages/landing-app/src/index.tsx. The logo and focus
    // manager do not read these SVG strings, so the harness invokes initializeSVGs
    // on the wireframes element the landing document renders.
    await writeFile(
        harnessPath,
        `
import { initializeSVGs } from "./svgs/index.ts";

const elem = document.querySelector<HTMLElement>(".landing-wireframes");
if (elem == null) {
    throw new Error("landing wireframes root missing");
}
initializeSVGs(elem);
window.__svgInitialized = true;
`,
    );

    const compiler = webpack({
        mode: "production",
        context: path.join(workDir, "src"),
        entry: harnessPath,
        output: {
            filename: "blueprint-landing.js",
            path: path.join(workDir, "dist"),
            publicPath: "",
        },
        resolve: {
            extensions: [".js", ".jsx", ".ts", ".tsx"],
        },
        resolveLoader: {
            modules: [path.join(toolchainDir, "node_modules")],
        },
        module: {
            rules: [
                {
                    test: /\.tsx?$/,
                    loader: swcLoader,
                    exclude: /node_modules/,
                    options: {
                        jsc: {
                            parser: {
                                decorators: true,
                                dynamicImport: true,
                                syntax: "typescript",
                                tsx: true,
                            },
                            transform: {
                                legacyDecorator: true,
                                react: {
                                    refresh: false,
                                    runtime: "automatic",
                                    useBuiltins: true,
                                },
                            },
                        },
                    },
                },
            ],
        },
        optimization: {
            minimize: true,
            minimizer: [
                new TerserPlugin({
                    extractComments: false,
                    terserOptions: {
                        format: {
                            comments: false,
                        },
                    },
                }),
            ],
        },
    });

    const stats = await new Promise((resolve, reject) => {
        compiler.run((error, result) => {
            compiler.close(() => {
                if (error != null) {
                    reject(error);
                    return;
                }
                resolve(result);
            });
        });
    });
    if (stats.hasErrors()) {
        throw new Error(
            stats
                .toJson()
                .errors.map(error => error.message)
                .join("\n"),
        );
    }
    return readFile(path.join(workDir, "dist/blueprint-landing.js"), "utf8");
}

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
}

async function openPage(url) {
    const profile = await mkdtemp(path.join(tmpdir(), "landing-svg-chrome-"));
    const port = 9300 + Math.floor(Math.random() * 500);
    const chrome = spawn(
        process.env.CHROME_PATH ?? "google-chrome",
        [
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--no-first-run",
            "--disable-extensions",
            `--remote-debugging-port=${port}`,
            `--user-data-dir=${profile}`,
            "about:blank",
        ],
        { stdio: "ignore" },
    );

    try {
        const version = await waitForDebugger(port);
        const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
        const page = targets.find(target => target.type === "page");
        if (page == null) {
            throw new Error(`Chrome did not expose a page target: ${JSON.stringify(version)}`);
        }
        return await evaluateInPage(page.webSocketDebuggerUrl, url);
    } finally {
        if (chrome.exitCode == null && chrome.signalCode == null) {
            chrome.kill("SIGKILL");
        }
        await new Promise(resolve => {
            if (chrome.exitCode != null || chrome.signalCode != null) {
                resolve();
                return;
            }
            chrome.once("exit", resolve);
        });
        await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
}

async function waitForDebugger(port) {
    let lastError;
    for (let attempt = 0; attempt < 50; attempt++) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (response.ok) {
                return response.json();
            }
        } catch (error) {
            lastError = error;
        }
        await delay(100);
    }
    throw new Error(`Chrome debugger did not start: ${lastError}`);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function evaluateInPage(webSocketUrl, url) {
    const socket = new WebSocket(webSocketUrl);
    await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", reject, { once: true });
    });

    let nextId = 0;
    const pending = new Map();
    const events = [];
    socket.addEventListener("message", event => {
        const message = JSON.parse(event.data);
        if (message.id != null && pending.has(message.id)) {
            const { resolve, reject } = pending.get(message.id);
            pending.delete(message.id);
            if (message.error != null) {
                reject(new Error(JSON.stringify(message.error)));
            } else {
                resolve(message.result);
            }
        } else if (message.method != null) {
            events.push(message);
        }
    });

    const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
            const id = ++nextId;
            pending.set(id, { resolve, reject });
            socket.send(JSON.stringify({ id, method, params }));
        });

    const loaded = new Promise(resolve => {
        const check = () => {
            const index = events.findIndex(message => message.method === "Page.loadEventFired");
            if (index >= 0) {
                resolve();
                return;
            }
            setTimeout(check, 20);
        };
        check();
    });

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Page.navigate", { url });
    await loaded;
    await delay(400);

    const evaluated = await send("Runtime.evaluate", {
        expression: `(() => {
            const root = document.querySelector(".landing-wireframes");
            const dangerous = [];
            const wrappers = root == null ? 0 : root.querySelectorAll(":scope > .landing-wireframe").length;
            if (root != null) {
                for (const el of root.querySelectorAll("*")) {
                    const tag = el.tagName.toLowerCase();
                    if (tag === "script" || tag === "foreignobject" || tag === "iframe" || tag === "object" || tag === "embed") {
                        dangerous.push(tag);
                    }
                    for (const attr of el.attributes) {
                        if (/^on/i.test(attr.name)) {
                            dangerous.push(attr.name.toLowerCase());
                        }
                        if (/javascript\\s*:/i.test(attr.value)) {
                            dangerous.push("javascript-url");
                        }
                    }
                }
            }
            const ran = Object.keys(window).filter(key => key.startsWith("__ran_")).sort();
            return { initialized: window.__svgInitialized === true, wrappers, ran, dangerous };
        })()`,
        returnByValue: true,
    });
    socket.close();
    if (evaluated.result?.value == null) {
        throw new Error(`Page evaluation failed: ${JSON.stringify(evaluated)}`);
    }
    return evaluated.result.value;
}

test("hero SVG files injected by initializeSVGs do not execute markup", { timeout: 180_000 }, async () => {
    const source = await readFile(indexSourcePath, "utf8");
    const ids = heroIdsFromSource(source);
    assert.deepEqual(ids, SVG_IDS, "hero SVG ids changed; extend this test to every raw-loader entry");

    const workDir = await mkdtemp(path.join(tmpdir(), "landing-svg-xss-"));
    const toolchainDir = path.join(tmpdir(), "blueprint-landing-svg-toolchain");
    try {
        await mkdir(path.join(workDir, "src/svgs"), { recursive: true });
        await copyFile(indexSourcePath, path.join(workDir, "src/svgs/index.ts"));
        for (const id of ids) {
            await writeFile(path.join(workDir, "src/svgs", `${id}.svg`), payloadFor(id));
        }

        await ensureToolchain(toolchainDir);
        const bundle = await buildLandingBundle(workDir, toolchainDir);
        const page = `<!DOCTYPE html>
<html><body>
<canvas id="pt-logo-background"></canvas>
<div class="landing-wireframes"></div>
<canvas id="pt-logo"></canvas>
<div id="copyright"></div>
<script src="/blueprint-landing.js"></script>
</body></html>`;

        const server = createServer((request, response) => {
            if (request.url?.startsWith("/blueprint-landing.js")) {
                response.setHeader("content-type", "text/javascript; charset=utf-8");
                response.end(bundle);
                return;
            }
            response.setHeader("content-type", "text/html; charset=utf-8");
            response.end(page);
        });
        const port = await listen(server);
        try {
            const report = await openPage(`http://127.0.0.1:${port}/`);
            assert.equal(report.initialized, true, "initializeSVGs did not finish");
            assert.equal(report.wrappers, ids.length, "every hero SVG must be inserted");
            assert.deepEqual(
                { ran: report.ran, dangerous: report.dangerous },
                { ran: [], dangerous: [] },
                "unsanitized hero SVG markup ran or was inserted as HTML",
            );
        } finally {
            server.close();
        }
    } finally {
        await rm(workDir, { recursive: true, force: true });
    }
});
