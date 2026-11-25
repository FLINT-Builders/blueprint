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

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { chdir } from "node:process";
import { before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(fileURLToPath(new URL("../package.json", import.meta.url)));
const webpack = require("webpack");
const WebpackDevServer = require("webpack-dev-server");
const WebSocket = require(require.resolve("ws", { paths: [require.resolve("webpack-dev-server")] }));

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SOURCE_MARKER = "UNPUBLISHED_DEV_BUNDLE_MARKER_9f3c";

const CONFIGS = [
    ["shared base config", "../webpack.config.base.mjs"],
    ["landing-app", "../../landing-app/webpack.config.mjs"],
    ["table-dev-app", "../../table-dev-app/webpack.config.mjs"],
    ["demo-app", "../../demo-app/webpack.config.mjs"],
    ["docs-app", "../../docs-app/webpack.config.mjs"],
];

/**
 * @typedef {{ name: string, devServer: Record<string, any>, devtool: string | false | undefined, mode: string | undefined }} LoadedConfig
 */

/** @type {LoadedConfig[]} */
const loadedConfigs = [];

describe("webpack-dev-server host rebinding", { concurrency: false }, () => {
    before(async () => {
        chdir(REPO_ROOT);
        for (const [name, specifier] of CONFIGS) {
            const mod = await import(pathToFileURL(fileURLToPath(new URL(specifier, import.meta.url))).href);
            loadedConfigs.push({
                devServer: mod.default.devServer,
                devtool: mod.default.devtool,
                mode: mod.default.mode,
                name,
            });
        }
    });

    for (const [name] of CONFIGS) {
        test(`${name} rejects a rebound Host, rejects its websocket, and stays on loopback`, async () => {
            const loaded = loadedConfigs.find(config => config.name === name);
            assert.ok(loaded, `missing loaded config for ${name}`);
            await assertDevServerRejectsRebinding(loaded);
        });
    }
});

/**
 * @param {LoadedConfig} loaded
 */
async function assertDevServerRejectsRebinding(loaded) {
    const attackerHost = `rebind-${randomBytes(6).toString("hex")}.attacker.test`;
    const workDir = await mkdtemp(join(tmpdir(), "blueprint-dev-server-"));
    const entryPath = join(workDir, "entry.js");
    await writeFile(entryPath, `export const unpublished = ${JSON.stringify(SOURCE_MARKER)};\n`);

    const compiler = webpack({
        devtool: loaded.devtool,
        entry: entryPath,
        infrastructureLogging: { level: "error" },
        mode: loaded.mode === "production" ? "development" : loaded.mode,
        output: {
            filename: "bundle.js",
            path: join(workDir, "dist"),
            publicPath: "/",
        },
    });

    // Clone so webpack-dev-server can normalize options without editing the shared config object.
    const devServer = structuredClone(loaded.devServer);
    devServer.port = 0;
    devServer.setupExitSignals = false;

    const server = new WebpackDevServer(devServer, compiler);
    try {
        await server.start();
        const address = server.server.address();
        assert.ok(address && typeof address === "object", `${loaded.name} did not listen on a TCP port`);
        const connectHost = loopbackClientHost(address);
        const port = address.port;

        const local = await httpGet(connectHost, port, "localhost");
        assert.equal(
            local.body.includes(SOURCE_MARKER),
            true,
            `${loaded.name} did not serve the compiled bundle to Host localhost`,
        );

        const rebound = await httpGet(connectHost, port, attackerHost);
        assert.equal(
            rebound.body.includes(SOURCE_MARKER),
            false,
            `${loaded.name} served unpublished bundle source to Host ${attackerHost}`,
        );
        assert.match(rebound.body, /Invalid Host header/);

        const localSocket = await collectSocketMessages(connectHost, port, "localhost");
        assert.ok(
            localSocket.some(message => /"type":"(hot|liveReload|hash|ok)"/.test(message)),
            `${loaded.name} did not accept a localhost hot-reload websocket: ${localSocket.join(" | ")}`,
        );

        const reboundSocket = await collectSocketMessages(connectHost, port, attackerHost);
        assert.equal(
            reboundSocket.some(message => /"type":"(hot|liveReload|hash|ok|progress)"/.test(message)),
            false,
            `${loaded.name} drove the hot-reload websocket for Host ${attackerHost}: ${reboundSocket.join(" | ")}`,
        );
        assert.ok(
            reboundSocket.some(message => message.includes("Invalid Host/Origin header")),
            `${loaded.name} websocket rejection was ${reboundSocket.join(" | ")}`,
        );

        assert.ok(
            address.address === "127.0.0.1" || address.address === "::1",
            `${loaded.name} listens on ${address.address}, so other machines can open the dev server`,
        );

        const externalIp = firstExternalIpv4();
        if (externalIp !== undefined) {
            await assertExternalInterfaceCannotReadBundle(loaded.name, externalIp, port);
        }
    } finally {
        await server.stop();
        await rm(workDir, { force: true, recursive: true });
    }
}

/**
 * webpack-dev-server 4.15.2 allows every IPv4 Host header once a TCP connection is accepted.
 * Binding to all interfaces therefore exposes the bundle to the LAN even after Host allowlisting.
 *
 * @param {string} name
 * @param {string} externalIp
 * @param {number} port
 */
async function assertExternalInterfaceCannotReadBundle(name, externalIp, port) {
    try {
        const response = await httpGet(externalIp, port, externalIp);
        assert.equal(
            response.body.includes(SOURCE_MARKER),
            false,
            `${name} served unpublished bundle source to ${externalIp}`,
        );
    } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (!["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL"].includes(code)) {
            throw error;
        }
    }
}

/**
 * @param {import("node:net").AddressInfo} address
 * @returns {string}
 */
function loopbackClientHost(address) {
    if (address.address === "0.0.0.0" || address.address === "127.0.0.1") {
        return "127.0.0.1";
    }
    if (address.address === "::" || address.address === "::1") {
        return "::1";
    }
    return address.address;
}

/**
 * @param {string} connectHost
 * @param {number} port
 * @param {string} hostHeader DNS name or IP the browser would put in Host, without a port
 * @returns {Promise<{ statusCode: number | undefined, body: string }>}
 */
function httpGet(connectHost, port, hostHeader) {
    return new Promise((resolve, reject) => {
        const request = http.request(
            {
                family: net.isIP(connectHost) === 6 ? 6 : 4,
                headers: { Host: `${hostHeader}:${port}` },
                host: connectHost,
                method: "GET",
                path: "/bundle.js",
                port,
            },
            response => {
                const chunks = [];
                response.on("data", chunk => chunks.push(chunk));
                response.on("end", () => {
                    resolve({
                        body: Buffer.concat(chunks).toString("utf8"),
                        statusCode: response.statusCode,
                    });
                });
            },
        );
        request.on("error", reject);
        request.end();
    });
}

/**
 * @param {string} connectHost
 * @param {number} port
 * @param {string} hostHeader
 * @returns {Promise<string[]>}
 */
function collectSocketMessages(connectHost, port, hostHeader) {
    const hostname = net.isIP(connectHost) === 6 ? `[${connectHost}]` : connectHost;
    const hostWithPort = `${hostHeader}:${port}`;
    return new Promise(resolve => {
        const socket = new WebSocket(`ws://${hostname}:${port}/ws`, {
            headers: {
                Host: hostWithPort,
                Origin: `http://${hostWithPort}`,
            },
        });
        /** @type {string[]} */
        const messages = [];
        let settled = false;
        const finish = () => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            socket.terminate();
            resolve(messages);
        };
        const timer = setTimeout(finish, 5000);
        socket.on("message", data => {
            messages.push(String(data));
            const sawRejection = messages.some(message => message.includes("Invalid Host/Origin header"));
            const sawAcceptance = messages.some(message => /"type":"(hot|liveReload|hash|ok)"/.test(message));
            if (sawRejection || sawAcceptance) {
                finish();
            }
        });
        socket.on("error", error => {
            messages.push(`ERROR ${error.message}`);
            finish();
        });
        socket.on("close", finish);
    });
}

/**
 * @returns {string | undefined}
 */
function firstExternalIpv4() {
    const interfaces = networkInterfaces();
    for (const addresses of Object.values(interfaces)) {
        for (const address of addresses ?? []) {
            if (address.family === "IPv4" && !address.internal) {
                return address.address;
            }
        }
    }
    return undefined;
}
