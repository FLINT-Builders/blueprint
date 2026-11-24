/*
 * Copyright 2017 Palantir Technologies, Inc. All rights reserved.
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

// Starts the docs/dev webpack-dev-server the way `pnpm dev` does, using the
// shared devServer options, and reports its heap to the parent test process.
// This file is not a test. It deliberately does not catch WebSocket errors:
// an unhandled error is the dev server crashing.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import webpack from "webpack";
import WebpackDevServer from "webpack-dev-server";

import { baseConfig } from "../index.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "blueprint-wds-"));
fs.mkdirSync(path.join(root, "assets"), { recursive: true });
fs.writeFileSync(path.join(root, "entry.js"), "export default 1;\n");

const compiler = webpack({
    context: root,
    entry: path.join(root, "entry.js"),
    mode: "development",
    output: {
        filename: "bundle.js",
        path: path.join(root, "dist"),
    },
});

const server = new WebpackDevServer(
    {
        ...baseConfig.devServer,
        devMiddleware: {
            ...baseConfig.devServer.devMiddleware,
            index: false,
        },
        open: false,
        port: 0,
        setupExitSignals: false,
        static: {
            directory: path.join(root, "assets"),
        },
    },
    compiler,
);

await server.start();

const address = server.server.address();
process.send({
    address: address.address,
    allowedHosts: baseConfig.devServer.allowedHosts,
    host: baseConfig.devServer.host,
    port: address.port,
    type: "listening",
});

process.on("message", message => {
    if (message?.type !== "mem") {
        return;
    }
    if (typeof global.gc === "function") {
        global.gc();
    }
    const usage = process.memoryUsage();
    process.send({
        heapUsed: usage.heapUsed,
        rss: usage.rss,
        type: "mem",
    });
});
