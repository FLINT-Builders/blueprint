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
import { spawn as nodeSpawn, exec as nodeExec } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import http from "node:http";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const packageDir = dirname(fileURLToPath(import.meta.url));
const webpackBuildScriptsDir = dirname(packageDir);

/**
 * Record the editor launch, then run a harmless process. launch-editor keeps the
 * child_process exports object, so replacing these methods is visible to it.
 */
const launches = [];
childProcess.spawn = function spawn(file, args, _options) {
    launches.push({ kind: "spawn", file, args: args ?? [] });
    return nodeSpawn("/bin/true", [], { stdio: "ignore" });
};
childProcess.exec = function exec(command, _options, callback) {
    launches.push({ kind: "exec", command });
    return nodeExec("/bin/true", { stdio: "ignore" }, callback);
};

const webpackDevServerPackage = require.resolve("webpack-dev-server/package.json", {
    paths: [webpackBuildScriptsDir],
});
const launchEditor = createRequire(webpackDevServerPackage)("launch-editor");
const webpack = require(require.resolve("webpack", { paths: [webpackBuildScriptsDir] }));
const WebpackDevServer = require(dirname(webpackDevServerPackage));

const ATTACKER_SEGMENT = "attacker%PATH%";

function attackFile(root) {
    return `${root}/${ATTACKER_SEGMENT}/..:1:1`;
}

function takeLaunches(root) {
    return launches.splice(0, launches.length).filter(call => {
        const serialized = JSON.stringify(call);
        return serialized.includes(root) || serialized.includes(ATTACKER_SEGMENT);
    });
}

function assertOpenedResolvedDirectory(calls, root) {
    assert.ok(
        calls.length > 0,
        "editor launch did not run for a parent directory that exists after the line suffix is removed",
    );
    for (const call of calls) {
        const serialized = JSON.stringify(call);
        assert.equal(
            serialized.includes(ATTACKER_SEGMENT),
            false,
            `editor launch kept the unresolved attacker path: ${serialized}`,
        );
        const rendered = call.kind === "exec" ? call.command : [...(call.args ?? []), call.file].join(" ");
        assert.ok(rendered.includes(root), `editor launch did not use the resolved directory: ${rendered}`);
        assert.equal(rendered.includes(`${root}/${ATTACKER_SEGMENT}`), false, rendered);
    }
}

test("launch-editor opens the resolved directory when the attacker segment does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "open-editor-missing-"));
    launches.length = 0;
    launchEditor(attackFile(root), "code");
    assertOpenedResolvedDirectory(takeLaunches(root), root);
});

test("launch-editor opens the resolved directory when the attacker segment does exist", () => {
    const root = mkdtempSync(join(tmpdir(), "open-editor-present-"));
    mkdirSync(join(root, ATTACKER_SEGMENT));
    launches.length = 0;
    launchEditor(attackFile(root), "code");
    assertOpenedResolvedDirectory(takeLaunches(root), root);
});

test("webpack-dev-server open-editor route forwards that file argument from any host", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-editor-route-"));
    const entry = join(root, "entry.js");
    writeFileSync(entry, "export {}\n");
    const compiler = webpack({
        mode: "development",
        context: root,
        entry,
        output: { path: join(root, "dist"), filename: "bundle.js" },
        infrastructureLogging: { level: "error" },
        stats: "errors-only",
    });
    const server = new WebpackDevServer(
        {
            allowedHosts: "all",
            host: "0.0.0.0",
            port: 0,
            hot: false,
            liveReload: false,
            webSocketServer: false,
            client: false,
            setupExitSignals: false,
            devMiddleware: { stats: "errors-only" },
        },
        compiler,
    );
    process.env.LAUNCH_EDITOR = "/bin/true";
    await server.start();
    try {
        const { port } = server.server.address();
        const response = await new Promise((resolve, reject) => {
            const req = http.request(
                {
                    host: "127.0.0.1",
                    port,
                    method: "GET",
                    path: "/webpack-dev-server/open-editor?fileName=" + encodeURIComponent(attackFile(root)),
                    headers: { Host: "evil.example" },
                },
                res => {
                    const chunks = [];
                    res.on("data", chunk => chunks.push(chunk));
                    res.on("end", () =>
                        resolve({
                            status: res.statusCode,
                            body: Buffer.concat(chunks).toString("utf8"),
                        }),
                    );
                },
            );
            req.on("error", reject);
            req.end();
        });
        assert.equal(response.status, 200);
        assert.equal(response.body.includes("Invalid Host header"), false);
        await new Promise(resolve => setTimeout(resolve, 50));
        assertOpenedResolvedDirectory(takeLaunches(root), root);
    } finally {
        delete process.env.LAUNCH_EDITOR;
        await server.stop();
    }
});
