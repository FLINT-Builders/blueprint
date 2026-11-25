/*
 * Copyright 2026 Palantir Technologies, Inc. All rights reserved.
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

// @ts-check

/**
 * The shared webpack development server listens on every interface and sets
 * allowedHosts to "all", which disables Host and Origin checks. These tests
 * exercise that server with the devServer object each app config actually
 * exports. They fail while a foreign host can read the development bundle
 * (including eval source-map sources) or open the hot-reload socket, and
 * while the process accepts connections on a non-loopback address.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const webpack = require("webpack");
const WebpackDevServer = require("webpack-dev-server");

const SOURCE_COMMENT = "BP_DEV_SERVER_SOURCE_COMMENT_9f3c1a";
const FOREIGN_HOST = "rebinding.example";

/** @type {string} */
let fixtureDir;
/** @type {string} */
let previousCwd;
/** @type {string | undefined} */
let previousNodeEnv;

const APP_CONFIGS = [
    {
        name: "docs-app",
        file: "packages/docs-app/webpack.config.mjs",
    },
    {
        name: "demo-app",
        file: "packages/demo-app/webpack.config.mjs",
    },
    {
        name: "landing-app",
        file: "packages/landing-app/webpack.config.mjs",
    },
    {
        name: "table-dev-app",
        file: "packages/table-dev-app/webpack.config.mjs",
    },
];

/**
 * @param {number} port
 * @param {string} connectHost
 * @param {string} hostHeader
 * @param {string} requestPath
 * @returns {Promise<{ status: number | undefined, body: string }>}
 */
function httpGet(port, connectHost, hostHeader, requestPath) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: connectHost,
                port,
                path: requestPath,
                method: "GET",
                headers: { Host: hostHeader },
            },
            res => {
                /** @type {Buffer[]} */
                const chunks = [];
                res.on("data", chunk => chunks.push(chunk));
                res.on("end", () => {
                    resolve({
                        status: res.statusCode,
                        body: Buffer.concat(chunks).toString("utf8"),
                    });
                });
            },
        );
        req.setTimeout(8000, () => {
            req.destroy(new Error(`timeout talking to ${connectHost}:${port}${requestPath}`));
        });
        req.on("error", reject);
        req.end();
    });
}

/**
 * @returns {Promise<number>}
 */
function allocatePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
            const address = probe.address();
            const port = address && typeof address === "object" ? address.port : 0;
            probe.close(() => resolve(port));
        });
    });
}

/**
 * @returns {string[]}
 */
function nonLoopbackIPv4Addresses() {
    /** @type {string[]} */
    const addresses = [];
    for (const entries of Object.values(os.networkInterfaces())) {
        for (const entry of entries ?? []) {
            const family = /** @type {string | number} */ (entry.family);
            if ((family === "IPv4" || family === 4) && !entry.internal) {
                addresses.push(entry.address);
            }
        }
    }
    return addresses;
}

/**
 * Read text frames from a webpack-dev-server /ws upgrade.
 *
 * @param {number} port
 * @param {string} hostHeader
 * @param {string} origin
 * @returns {Promise<string[]>}
 */
function hotReloadMessages(port, hostHeader, origin) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: "127.0.0.1",
            port,
            path: "/ws",
            headers: {
                Connection: "Upgrade",
                Upgrade: "websocket",
                "Sec-WebSocket-Version": "13",
                "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
                Host: hostHeader,
                Origin: origin,
            },
        });
        /** @type {string[]} */
        const messages = [];
        let buffer = Buffer.alloc(0);
        let settled = false;

        const finish = () => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            resolve(messages);
        };

        const timer = setTimeout(finish, 4000);

        /**
         * @param {Buffer} chunk
         */
        const consume = chunk => {
            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length >= 2) {
                const opcode = buffer[0] & 0x0f;
                let length = buffer[1] & 0x7f;
                let offset = 2;
                if (length === 126) {
                    if (buffer.length < 4) {
                        return;
                    }
                    length = buffer.readUInt16BE(2);
                    offset = 4;
                } else if (length === 127) {
                    if (buffer.length < 10) {
                        return;
                    }
                    length = Number(buffer.readBigUInt64BE(2));
                    offset = 10;
                }
                if (buffer.length < offset + length) {
                    break;
                }
                const payload = buffer.subarray(offset, offset + length);
                buffer = buffer.subarray(offset + length);
                if (opcode === 0x1) {
                    messages.push(payload.toString("utf8"));
                } else if (opcode === 0x8) {
                    messages.push("__close__");
                }
            }
            const joined = messages.join("\n");
            if (joined.includes("Invalid Host/Origin header") || joined.includes('"type":"hot"')) {
                finish();
            }
        };

        req.on("upgrade", (_res, socket, head) => {
            // The opening handshake frames are often already buffered on `head`.
            consume(head);
            socket.on("data", consume);
            socket.on("end", finish);
            socket.on("close", finish);
            socket.on("error", finish);
        });
        req.on("response", res => {
            /** @type {Buffer[]} */
            const chunks = [];
            res.on("data", chunk => chunks.push(chunk));
            res.on("end", () => {
                messages.push(`http ${res.statusCode} ${Buffer.concat(chunks).toString("utf8")}`);
                finish();
            });
        });
        req.on("error", error => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        req.end();
    });
}

/**
 * Mirrors @webpack-cli/serve: shallow-copy devServer, run processArguments with no CLI flags,
 * then construct webpack-dev-server. devtool is a webpack option and is not part of devServer.
 *
 * @param {object} devServer
 * @param {import("webpack").Configuration["devtool"]} devtool
 * @param {number} port
 */
async function startServer(devServer, devtool, port) {
    // webpack 5 shallow-copies devServer and does not rewrite host or allowedHosts.
    const normalized = webpack.config.getNormalizedWebpackOptions({
        mode: "development",
        context: fixtureDir,
        entry: "./entry.js",
        devtool,
        devServer: structuredClone(devServer),
    });
    const devServerOptions = Object.assign({}, normalized.devServer, { port });
    const problems = WebpackDevServer.cli.processArguments({}, devServerOptions, {});
    assert.equal(problems, null);

    const compiler = webpack({
        mode: "development",
        context: fixtureDir,
        entry: "./entry.js",
        devtool,
        output: {
            filename: "bundle.js",
            path: path.join(fixtureDir, "dist"),
            publicPath: "/",
        },
        infrastructureLogging: { level: "error" },
    });

    const server = new WebpackDevServer(devServerOptions, compiler);
    await server.start();
    return server;
}

/**
 * @param {number} port
 */
async function waitForLocalSource(port) {
    const deadline = Date.now() + 60_000;
    let lastBody = "";
    while (Date.now() < deadline) {
        try {
            const response = await httpGet(port, "127.0.0.1", `127.0.0.1:${port}`, "/bundle.js");
            lastBody = response.body;
            if (response.body.includes(SOURCE_COMMENT)) {
                return response.body;
            }
        } catch (error) {
            lastBody = error instanceof Error ? error.message : String(error);
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`development bundle never exposed ${SOURCE_COMMENT}. Last body: ${lastBody.slice(0, 300)}`);
}

before(async () => {
    previousCwd = process.cwd();
    previousNodeEnv = process.env.NODE_ENV;
    // The documented dev scripts do not set NODE_ENV=production. Production mode turns devtool off.
    if (process.env.NODE_ENV === "production") {
        delete process.env.NODE_ENV;
    }

    fixtureDir = await mkdtemp(path.join(os.tmpdir(), "blueprint-dev-server-"));
    await mkdir(path.join(fixtureDir, "src", "assets"), { recursive: true });
    await writeFile(
        path.join(fixtureDir, "package.json"),
        JSON.stringify({ name: "blueprint-dev-server-host-check-fixture" }),
    );
    await writeFile(path.join(fixtureDir, "entry.js"), `// ${SOURCE_COMMENT}\nexport const value = 1;\n`);
    process.chdir(fixtureDir);
});

after(async () => {
    process.chdir(previousCwd);
    if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
    } else {
        process.env.NODE_ENV = previousNodeEnv;
    }
});

/**
 * @param {string} name
 * @param {string} configUrl
 */
async function loadDevServer(name, configUrl) {
    const loaded = await import(configUrl);
    const config = loaded.default;
    assert.ok(config && typeof config === "object", `${name} webpack config has no default export`);
    assert.equal(config.devtool, "eval-source-map", `${name} development builds are expected to ship eval source maps`);
    assert.ok(config.devServer, `${name} webpack config has no devServer`);
    return { ...config, devServer: config.devServer };
}

/**
 * @param {string} name
 * @param {import("webpack").Configuration["devtool"]} devtool
 * @param {object} devServer
 */
async function assertDevServerIsLocalOnly(name, devtool, devServer) {
    assert.equal(devtool, "eval-source-map", name);
    const port = await allocatePort();
    const server = await startServer(devServer, devtool, port);
    /** @type {string[]} */
    const failures = [];
    try {
        const listening = server.server?.address();
        if (!listening || typeof listening !== "object") {
            failures.push(`${name} did not bind a TCP port`);
        } else if (!/^(127\.0\.0\.1|::1)$/.test(listening.address)) {
            failures.push(`${name} development server is reachable on ${listening.address}, not only loopback`);
        }

        for (const lanAddress of nonLoopbackIPv4Addresses()) {
            try {
                const lanResponse = await httpGet(port, lanAddress, `${lanAddress}:${port}`, "/bundle.js");
                failures.push(
                    `${name} accepted a connection on ${lanAddress}:${port} (status ${lanResponse.status}, ${lanResponse.body.length} bytes)`,
                );
            } catch (error) {
                const code = /** @type {NodeJS.ErrnoException} */ (error).code;
                if (code !== "ECONNREFUSED" && code !== "EHOSTUNREACH" && code !== "ENETUNREACH") {
                    failures.push(`${name} failed while connecting to ${lanAddress}:${port}: ${code ?? error}`);
                }
            }
        }

        await waitForLocalSource(port);

        const rebindingBundle = await httpGet(port, "127.0.0.1", `${FOREIGN_HOST}:${port}`, "/bundle.js");
        if (rebindingBundle.body !== "Invalid Host header" || rebindingBundle.body.includes(SOURCE_COMMENT)) {
            failures.push(
                `${name} served the development bundle to Host ${FOREIGN_HOST} ` +
                    `(contains source comment: ${rebindingBundle.body.includes(SOURCE_COMMENT)})`,
            );
        }

        const invalidate = await httpGet(
            port,
            "127.0.0.1",
            `${FOREIGN_HOST}:${port}`,
            "/webpack-dev-server/invalidate",
        );
        if (invalidate.body !== "Invalid Host header") {
            failures.push(`${name} invalidate endpoint accepted ${FOREIGN_HOST}`);
        }

        const assets = await httpGet(port, "127.0.0.1", `${FOREIGN_HOST}:${port}`, "/webpack-dev-server");
        if (assets.body !== "Invalid Host header") {
            failures.push(`${name} asset report accepted ${FOREIGN_HOST}`);
        }

        const messages = await hotReloadMessages(port, `${FOREIGN_HOST}:${port}`, `http://${FOREIGN_HOST}:${port}`);
        const joined = messages.join("\n");
        if (!joined.includes("Invalid Host/Origin header") || joined.includes('"type":"hot"')) {
            failures.push(`${name} hot-reload socket accepted ${FOREIGN_HOST}: ${joined.slice(0, 240)}`);
        }
    } finally {
        await server.stop();
    }

    assert.deepEqual(failures, []);
}

test("development servers reject rebinding hosts and stay on loopback", async t => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const baseUrl = pathToFileURL(path.join(repoRoot, "packages/webpack-build-scripts/webpack.config.base.mjs")).href;
    const baseLoaded = await import(baseUrl);

    /** @type {{ name: string, devtool: import("webpack").Configuration["devtool"], devServer: object }[]} */
    const configs = [
        {
            name: "webpack-build-scripts base config",
            devtool: baseLoaded.default.devtool,
            devServer: baseLoaded.default.devServer,
        },
    ];

    for (const app of APP_CONFIGS) {
        const loaded = await loadDevServer(app.name, pathToFileURL(path.join(repoRoot, app.file)).href);
        configs.push({
            name: app.name,
            devtool: /** @type {import("webpack").Configuration["devtool"]} */ (loaded.devtool),
            devServer: loaded.devServer,
        });
    }

    for (const config of configs) {
        await t.test(config.name, async () => {
            await assertDevServerIsLocalOnly(config.name, config.devtool, config.devServer);
        });
    }
});
