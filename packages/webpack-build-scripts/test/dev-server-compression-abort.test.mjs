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

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";

import { baseConfig } from "../index.mjs";

const require = createRequire(import.meta.url);
const webpack = require("webpack");
const WebpackDevServer = require("webpack-dev-server");

const zlibStreams = [];
for (const method of ["createGzip", "createDeflate", "createBrotliCompress"]) {
    const original = zlib[method];
    Object.defineProperty(zlib, method, {
        configurable: true,
        enumerable: true,
        value(...args) {
            const stream = original.apply(this, args);
            zlibStreams.push(stream);
            return stream;
        },
        writable: true,
    });
}

// docs-app, demo-app, landing-app, and table-dev-app all spread this devServer
// and do not set `compress`. webpack-dev-server@4 then defaults compress to on
// and mounts compression() in front of webpack-dev-middleware and express.static.
const ENCODINGS = ["gzip", "deflate", "br"];

function nonLoopbackIPv4() {
    for (const entries of Object.values(networkInterfaces())) {
        for (const entry of entries ?? []) {
            const isV4 = entry.family === "IPv4" || entry.family === 4;
            if (isV4 && entry.internal === false) {
                return entry.address;
            }
        }
    }
    return undefined;
}

function releaseStreams() {
    for (const stream of zlibStreams) {
        if (typeof stream.destroy === "function" && stream.destroyed !== true) {
            stream.destroy();
        }
    }
}

/**
 * Read response headers, then destroy the socket while the body is still arriving.
 *
 * @param {number} port
 * @param {string} address
 * @param {string} urlPath
 * @param {string} encoding
 * @param {string | undefined} range
 * @returns {Promise<string>}
 */
function abortCompressedRequest(port, address, urlPath, encoding, range) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, address);
        let received = Buffer.alloc(0);
        const timer = setTimeout(() => {
            socket.destroy();
            reject(
                new Error(
                    `timed out waiting for ${urlPath} (${encoding})\n${received.slice(0, 400).toString("latin1")}`,
                ),
            );
        }, 8000);
        socket.on("error", error => {
            if (error.code !== "ECONNRESET" && error.code !== "EPIPE") {
                clearTimeout(timer);
                reject(error);
            }
        });
        socket.on("connect", () => {
            const rangeHeader = range === undefined ? "" : `Range: ${range}\r\n`;
            socket.write(
                `GET ${urlPath} HTTP/1.1\r\nHost: attacker.example\r\nAccept-Encoding: ${encoding}\r\n${rangeHeader}Connection: keep-alive\r\n\r\n`,
            );
        });
        socket.on("data", chunk => {
            received = Buffer.concat([received, chunk]);
            const headerEnd = received.indexOf("\r\n\r\n");
            // Headers plus a small part of the body: the compressor has started, and the body is not finished.
            if (headerEnd !== -1 && received.length > headerEnd + 48) {
                clearTimeout(timer);
                const headers = received.slice(0, headerEnd).toString("latin1");
                socket.destroy();
                resolve(headers);
            }
        });
    });
}

test("aborted compressed webpack-dev-server responses release zlib streams", { timeout: 60_000 }, async () => {
    const devServerConfig = baseConfig.devServer;
    assert.equal(devServerConfig.host, "0.0.0.0");
    assert.equal(devServerConfig.allowedHosts, "all");
    assert.equal(Object.hasOwn(devServerConfig, "compress"), false);

    const peerAddress = nonLoopbackIPv4();
    assert.ok(peerAddress, "expected a non-loopback IPv4 address to reach a server bound to 0.0.0.0");

    const workdir = mkdtempSync(join(tmpdir(), "blueprint-dev-server-leak-"));
    const assetsDir = join(workdir, "assets");
    mkdirSync(assetsDir);
    // Incompressible bodies keep the zlib stream writing when the client disconnects.
    // Highly repetitive bodies can finish compression before the abort is observed.
    const payload = randomBytes(512_000).toString("base64");
    writeFileSync(join(workdir, "entry.js"), `module.exports = ${JSON.stringify(payload)};\n`);
    writeFileSync(join(assetsDir, "big.js"), payload);

    const compiler = webpack({
        context: workdir,
        entry: join(workdir, "entry.js"),
        infrastructureLogging: { level: "error" },
        mode: "development",
        output: {
            filename: "bundle.js",
            path: join(workdir, "dist"),
            publicPath: "/",
        },
        stats: "errors-only",
    });

    const server = new WebpackDevServer(
        {
            ...devServerConfig,
            port: 0,
            setupExitSignals: false,
            static: {
                ...devServerConfig.static,
                directory: assetsDir,
                watch: false,
            },
        },
        compiler,
    );

    try {
        await server.start();
        const listening = server.server.address();
        assert.equal(listening.address, "0.0.0.0");
        assert.equal(server.options.compress, true);

        zlibStreams.length = 0;
        const responses = [];
        for (const encoding of ENCODINGS) {
            // webpack-dev-middleware streams a Range request through memfs.createReadStream().pipe(res).
            responses.push({
                encoding,
                headers: await abortCompressedRequest(
                    listening.port,
                    peerAddress,
                    "/bundle.js",
                    encoding,
                    "bytes=0-1048575",
                ),
                kind: "bundle-range",
            });
            // express.static (send@0.19.0) pipes fs.createReadStream into the same compression middleware.
            responses.push({
                encoding,
                headers: await abortCompressedRequest(listening.port, peerAddress, "/big.js", encoding, undefined),
                kind: "static-file",
            });
        }

        await new Promise(resolve => {
            setTimeout(resolve, 750);
        });

        assert.equal(responses.length, ENCODINGS.length * 2);
        for (const response of responses) {
            assert.equal(
                response.headers.includes("Invalid Host header"),
                false,
                `${response.kind} ${response.encoding} was rejected by the host check:\n${response.headers}`,
            );
            assert.match(
                response.headers,
                /^HTTP\/1\.1 (200|206) /,
                `${response.kind} ${response.encoding} was not served:\n${response.headers}`,
            );
            assert.match(
                response.headers,
                new RegExp(`Content-Encoding: ${response.encoding}`, "i"),
                `${response.kind} ${response.encoding} was not compressed:\n${response.headers}`,
            );
        }
        assert.equal(
            zlibStreams.length,
            responses.length,
            "each aborted compressed response should have created one zlib stream",
        );

        const stillOpen = zlibStreams.flatMap((stream, index) => {
            if (stream.destroyed === true && stream["_handle"] == null) {
                return [];
            }
            const response = responses[index];
            return [`${response?.kind ?? "unknown"} ${response?.encoding ?? "unknown"}`];
        });
        assert.deepEqual(
            stillOpen,
            [],
            `zlib streams were still alive after the client aborted the compressed response: ${stillOpen.join(", ")}`,
        );
    } finally {
        releaseStreams();
        await server.stop();
        rmSync(workdir, { force: true, recursive: true });
    }
});
