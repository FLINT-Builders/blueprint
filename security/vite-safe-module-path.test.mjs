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

/**
 * Spec for the Vite dev-server file disclosure reachable from `pnpm storybook`.
 *
 * Storybook 10.2.14 starts Vite in middleware mode (`@storybook/builder-vite`) and
 * `http.Server.listen`s without a host, which binds every interface. `.storybook/main.ts`
 * does not set `server.host` or `server.fs.deny`. Import analysis in Vite 7.1.12 stores the
 * root-relative browser URL in `safeModulePaths`. A later `/@fs` request for a host file at
 * that same path is then allowed even though the imported file lives inside the project.
 *
 * Run: node --test security/vite-safe-module-path.test.mjs
 * Requires the workspace `vite` install (the version locked in pnpm-lock.yaml).
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";

const HOST_TEXT = "HOST_TEXT_OUTSIDE_PROJECT";
const PROJECT_TEXT = "PROJECT_TEXT_INSIDE_ROOT";
const HOST_JS = "HOST_JS_OUTSIDE_PROJECT";
const PROJECT_JS = "PROJECT_JS_INSIDE_ROOT";
const HOST_PEM = "HOST_PEM_PLACEHOLDER_NOT_A_CREDENTIAL";
const HOST_OTHER = "HOST_OTHER_NOT_IMPORTED";

test("network client cannot read host files authorized only by a project-relative import URL", async t => {
    const id = `blueprint-vite-fs-${process.pid}-${Date.now()}`;
    const hostTextPath = path.join("/tmp", `${id}.txt`);
    const hostJsPath = path.join("/tmp", `${id}.js`);
    const hostPemPath = path.join("/tmp", `${id}.pem`);
    const hostOtherPath = path.join("/tmp", `${id}-other.txt`);
    const root = mkdtempSync(path.join(os.tmpdir(), "blueprint-storybook-vite-"));
    const created = [hostTextPath, hostJsPath, hostPemPath, hostOtherPath];

    mkdirSync(path.join(root, "tmp"));
    writeFileSync(path.join(root, "tmp", `${id}.txt`), PROJECT_TEXT);
    writeFileSync(path.join(root, "tmp", `${id}.js`), `export const marker = ${JSON.stringify(PROJECT_JS)}\n`);
    writeFileSync(path.join(root, "tmp", `${id}.pem`), "PROJECT_PEM_PLACEHOLDER_NOT_A_CREDENTIAL");
    writeFileSync(
        path.join(root, "entry.js"),
        [
            `import ${JSON.stringify(`./tmp/${id}.txt`)}`,
            `import ${JSON.stringify(`./tmp/${id}.js`)}`,
            `import ${JSON.stringify(`./tmp/${id}.pem`)}`,
            "export const ready = true",
            "",
        ].join("\n"),
    );
    writeFileSync(hostTextPath, HOST_TEXT);
    writeFileSync(hostJsPath, `export const marker = ${JSON.stringify(HOST_JS)}\n`);
    writeFileSync(hostPemPath, HOST_PEM);
    writeFileSync(hostOtherPath, HOST_OTHER);

    // Same shape as @storybook/builder-vite createViteServer plus Storybook's
    // polka listen({ port, host }) when --host is omitted: middleware mode, strict
    // fs, no custom deny list, and a server bound on every interface.
    const httpServer = http.createServer();
    const vite = await createServer({
        configFile: false,
        root,
        base: "./",
        appType: "custom",
        logLevel: "error",
        optimizeDeps: { noDiscovery: true },
        server: {
            middlewareMode: true,
            hmr: { server: httpServer },
            fs: { strict: true },
            watch: null,
        },
    });
    httpServer.on("request", (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        vite.middlewares(req, res, () => {
            res.statusCode = 404;
            res.end("fallthrough");
        });
    });

    t.after(async () => {
        await vite.close();
        if (httpServer.listening) {
            await new Promise(resolve => httpServer.close(resolve));
        }
        rmSync(root, { recursive: true, force: true });
        for (const filePath of created) {
            rmSync(filePath, { force: true });
        }
    });

    await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen({ port: 0, host: undefined }, resolve);
    });

    const address = httpServer.address();
    assert.equal(typeof address, "object");
    assert.ok(address);
    assert.equal(address.address, "::");

    const networkIp = nonInternalIpv4();
    assert.ok(networkIp, "a non-loopback IPv4 address is required to reach the dev server");

    const request = pathname =>
        fetch(`http://${networkIp}:${address.port}${pathname}`, {
            headers: { host: `${networkIp}:${address.port}` },
        }).then(async response => ({ status: response.status, body: await response.text() }));

    const outsideTextUrl = `/@fs/tmp/${id}.txt`;
    const outsideJsUrl = `/@fs/tmp/${id}.js`;
    const outsidePemUrl = `/@fs/tmp/${id}.pem`;
    const outsideOtherUrl = `/@fs/tmp/${id}-other.txt`;

    const beforeImport = await request(outsideTextUrl);
    assert.equal(beforeImport.status, 403, beforeImport.body);
    assert.equal(beforeImport.body.includes(HOST_TEXT), false);

    const entry = await request("/entry.js");
    assert.equal(entry.status, 200, entry.body);
    assert.equal(entry.body.includes(`/tmp/${id}.txt`), true);
    assert.equal(entry.body.includes(`/tmp/${id}.js`), true);

    const projectFile = await request(`/tmp/${id}.txt`);
    assert.equal(projectFile.status, 200, projectFile.body);
    assert.equal(projectFile.body.includes(PROJECT_TEXT), true);
    assert.equal(projectFile.body.includes(HOST_TEXT), false);

    const failures = [];
    const expectHidden = (label, result, secret) => {
        if (result.status !== 403) {
            failures.push(`${label}: status ${result.status}, body ${JSON.stringify(result.body.slice(0, 180))}`);
        }
        if (result.body.includes(secret)) {
            failures.push(`${label}: response contained the host file`);
        }
    };

    expectHidden("raw text /@fs", await request(outsideTextUrl), HOST_TEXT);
    expectHidden("transformed js /@fs", await request(outsideJsUrl), HOST_JS);
    expectHidden("raw text /@fs?raw", await request(`${outsideTextUrl}?raw`), HOST_TEXT);
    expectHidden("js /@fs?raw", await request(`${outsideJsUrl}?raw`), HOST_JS);
    expectHidden("denied pem /@fs", await request(outsidePemUrl), HOST_PEM);
    expectHidden("unimported host file", await request(outsideOtherUrl), HOST_OTHER);

    assert.deepEqual(failures, []);
});

function nonInternalIpv4() {
    for (const addresses of Object.values(os.networkInterfaces())) {
        for (const address of addresses ?? []) {
            if (address.family === "IPv4" && !address.internal) {
                return address.address;
            }
        }
    }
    return undefined;
}
