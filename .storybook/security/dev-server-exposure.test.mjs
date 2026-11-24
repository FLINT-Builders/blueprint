/* !
 * (c) Copyright 2026 Palantir Technologies Inc. All rights reserved.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const storyMarker = "globalThis.__STORY_EXPOSURE";
const outsideMarker = "globalThis.__OUTSIDE_EXPOSURE";
const createdMarker = "globalThis.__CREATED_EXPOSURE";
const storySource = `const meta = { component: () => null };
export default meta;
export const Primary = {};
`;
const outsideSource = `const meta = { component: () => null };
export default meta;
export const Primary = {};
`;

let server;
let tempRoot;
let appDir;
let storyPath;
let outsidePath;
let createdStoryPath;
let port;

test("storybook dev, as started by the root script, is not writable from another host", async () => {
    assert.equal(process.platform, "linux", "listening-address check reads /proc/net/tcp");
    tempRoot = await mkdtemp(join(tmpdir(), "storybook-exposure-"));
    appDir = join(tempRoot, "app");
    const outsideDir = join(tempRoot, "outside");
    storyPath = join(appDir, "src", "Button.stories.tsx");
    outsidePath = join(outsideDir, "Victim.stories.tsx");
    createdStoryPath = join(appDir, "src", "Widget.stories.tsx");
    await writeFixture(appDir, outsideDir);
    port = await freePort();
    server = await startStorybook(appDir, port);

    const sockets = listeningSockets(server.pid, port);
    const exposed = sockets.filter(socket => !socket.loopback);
    const lanAddress = firstExternalIpv4();
    const attack = lanAddress ? await attackFromHost(lanAddress, port) : undefined;
    const failures = [];
    if (sockets.length === 0) {
        failures.push("the dev server did not open a listening socket");
    }
    if (exposed.length > 0) {
        const addresses = exposed.map(socket => socket.address).join(", ");
        failures.push(`dev server accepts non-loopback connections on ${addresses}`);
    }
    if (!lanAddress) {
        failures.push("this machine has no external IPv4 address to act as another host");
    }
    if (attack?.connected) {
        failures.push("another host loaded the dev server");
    }
    if ((await readFile(storyPath, "utf8")) !== storySource) {
        failures.push("saveStoryRequest changed an in-project story file");
    }
    if ((await readFile(outsidePath, "utf8")) !== outsideSource) {
        failures.push("saveStoryRequest changed a story file outside the project");
    }
    if (existsSync(createdStoryPath)) {
        failures.push("createNewStoryfileRequest created a story file in the project");
    }
    assert.deepEqual(failures, []);
});

after(async () => {
    if (server) {
        stopProcess(server);
        server = undefined;
    }
    if (tempRoot) {
        await rm(tempRoot, { force: true, recursive: true });
    }
});

async function writeFixture(projectDir, outsideDir) {
    mkdirSync(join(projectDir, ".storybook"), { recursive: true });
    mkdirSync(join(projectDir, "src"), { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    await writeFile(
        join(projectDir, "package.json"),
        JSON.stringify({ name: "storybook-exposure-fixture", private: true }),
    );
    await writeFile(
        join(projectDir, ".storybook", "main.ts"),
        `import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
    stories: ["../src/**/*.stories.tsx"],
    framework: "@storybook/react-vite",
    core: { disableTelemetry: true },
};
export default config;
`,
    );
    await writeFile(storyPath, storySource);
    await writeFile(join(projectDir, "src", "Widget.tsx"), "export const Widget = () => null;\n");
    await writeFile(outsidePath, outsideSource);
    linkDependencies(projectDir);
}

function linkDependencies(projectDir) {
    const destination = join(projectDir, "node_modules");
    mkdirSync(join(destination, "@storybook"), { recursive: true });
    for (const name of ["storybook", "react", "react-dom", "vite"]) {
        symlinkSync(resolve(repoRoot, "node_modules", name), join(destination, name));
    }
    symlinkSync(
        resolve(repoRoot, "node_modules", "@storybook", "react-vite"),
        join(destination, "@storybook", "react-vite"),
    );
}

function storybookArgs(listenPort) {
    const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const script = packageJson.scripts.storybook;
    assert.equal(typeof script, "string");
    assert.ok(script.startsWith("storybook "), "root storybook script does not invoke the storybook CLI");
    const tokens = script.slice("storybook ".length).split(/\s+/).filter(Boolean);
    const args = [];
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === "-p" || token === "--port") {
            args.push(token, String(listenPort));
            index += 1;
            continue;
        }
        args.push(token);
    }
    // These flags only stop prompts, the browser, and telemetry. They do not set --host.
    for (const flag of ["--ci", "--no-open", "--exact-port", "--disable-telemetry"]) {
        if (!args.includes(flag)) {
            args.push(flag);
        }
    }
    assert.equal(args.includes("--host"), false);
    assert.equal(args.includes("-h"), false);
    return args;
}

async function startStorybook(projectDir, listenPort) {
    const dispatcher = resolve(repoRoot, "node_modules", "storybook", "dist", "bin", "dispatcher.js");
    assert.ok(existsSync(dispatcher), "storybook is not installed");
    const env = { ...process.env, BROWSER: "none", CI: "true", STORYBOOK_DISABLE_TELEMETRY: "1" };
    delete env.STORYBOOK_PROJECT_ROOT;
    const output = [];
    const child = spawn(process.execPath, [dispatcher, ...storybookArgs(listenPort)], {
        cwd: projectDir,
        detached: true,
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", chunk => output.push(chunk));
    child.stderr.on("data", chunk => output.push(chunk));
    const ready = waitForOutput(child, output, listenPort);
    const started = await ready;
    assert.equal(started, true, `storybook did not start\n${redact(Buffer.concat(output).toString("utf8"))}`);
    return child;
}

function waitForOutput(child, output, listenPort) {
    return new Promise(resolveReady => {
        const timeout = setTimeout(() => resolveReady(false), 90_000);
        const finish = ready => {
            clearTimeout(timeout);
            resolveReady(ready);
        };
        child.on("exit", () => finish(false));
        const onData = () => {
            const text = Buffer.concat(output).toString("utf8");
            if (text.includes("Storybook ready") || text.includes(`localhost:${listenPort}`)) {
                finish(true);
            }
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
    });
}

function stopProcess(child) {
    if (!child.pid || child.exitCode != null) {
        return;
    }
    try {
        process.kill(-child.pid, "SIGTERM");
    } catch {
        child.kill("SIGTERM");
    }
}

async function attackFromHost(host, listenPort) {
    const result = {
        connected: false,
        created: false,
        outsidePlanted: false,
        storyPlanted: false,
    };
    let page = "";
    let preview = "";
    try {
        page = await fetchText(`http://${host}:${listenPort}/`);
        preview = await fetchText(`http://${host}:${listenPort}/iframe.html`);
    } catch {
        return result;
    }
    result.connected = true;
    const credential = readChannelCredential(page) ?? readChannelCredential(preview);
    if (!credential) {
        return result;
    }
    const socket = new globalThis.WebSocket(
        `ws://${host}:${listenPort}/storybook-server-channel?token=${encodeURIComponent(credential)}`,
    );
    try {
        await new Promise((resolveOpen, rejectOpen) => {
            const timeout = setTimeout(() => rejectOpen(new Error("channel timeout")), 5_000);
            socket.addEventListener("open", () => {
                clearTimeout(timeout);
                resolveOpen();
            });
            socket.addEventListener("error", () => {
                clearTimeout(timeout);
                rejectOpen(new Error("channel error"));
            });
        });
    } catch {
        socket.close();
        return result;
    }
    socket.send(
        JSON.stringify({
            args: [
                {
                    id: "exposure-save",
                    payload: {
                        args: JSON.stringify({ label: "exposure" }),
                        csfId: "button--primary",
                        importPath: "src/Button.stories.tsx",
                        name: `Injected; ${storyMarker} = 1; const Unused`,
                    },
                },
            ],
            from: "exposure",
            type: "saveStoryRequest",
        }),
    );
    socket.send(
        JSON.stringify({
            args: [
                {
                    id: "exposure-outside",
                    payload: {
                        args: JSON.stringify({ label: "exposure" }),
                        csfId: "victim--primary",
                        importPath: "../outside/Victim.stories.tsx",
                        name: `Escaped; ${outsideMarker} = 1; const Unused`,
                    },
                },
            ],
            from: "exposure",
            type: "saveStoryRequest",
        }),
    );
    socket.send(
        JSON.stringify({
            args: [
                {
                    id: "exposure-create",
                    payload: {
                        componentExportCount: 1,
                        componentExportName: `Widget }; ${createdMarker} = 1; export const Extra = { x: 1`,
                        componentFilePath: "src/Widget.tsx",
                        componentIsDefaultExport: false,
                    },
                },
            ],
            from: "exposure",
            type: "createNewStoryfileRequest",
        }),
    );
    await delay(2_000);
    socket.close();
    result.storyPlanted = (await readFile(storyPath, "utf8")).includes(storyMarker);
    result.outsidePlanted = (await readFile(outsidePath, "utf8")).includes(outsideMarker);
    result.created = existsSync(createdStoryPath);
    return result;
}

function readChannelCredential(html) {
    const match = html.match(/CHANNEL_OPTIONS['"\]]?\s*=\s*(\{[\s\S]*?\});/);
    if (!match) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(match[1]);
        return typeof parsed.wsToken === "string" && parsed.wsToken.length > 0 ? parsed.wsToken : undefined;
    } catch {
        return undefined;
    }
}

async function fetchText(url) {
    const response = await globalThis.fetch(url, { signal: globalThis.AbortSignal.timeout(4_000) });
    return response.text();
}

function firstExternalIpv4() {
    const addresses = Object.values(networkInterfaces())
        .flat()
        .filter(entry => entry && entry.family === "IPv4" && !entry.internal)
        .map(entry => entry.address);
    return addresses[0];
}

function listeningSockets(rootPid, listenPort) {
    const inodes = new Set();
    for (const pid of processTree(rootPid)) {
        for (const inode of socketInodes(pid)) {
            inodes.add(inode);
        }
    }
    const sockets = [];
    for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
        const lines = readFileSync(table, "utf8").trim().split("\n").slice(1);
        for (const line of lines) {
            const fields = line.trim().split(/\s+/);
            const [address, portHex] = fields[1].split(":");
            const state = fields[3];
            const inode = fields[9];
            if (state !== "0A" || !inodes.has(inode) || Number.parseInt(portHex, 16) !== listenPort) {
                continue;
            }
            const decoded = table.endsWith("6") ? decodeIpv6(address) : decodeIpv4(address);
            sockets.push({ address: decoded, loopback: isLoopback(decoded) });
        }
    }
    return sockets;
}

function processTree(rootPid) {
    const children = new Map();
    for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) {
            continue;
        }
        try {
            const stat = readFileSync(join("/proc", name, "stat"), "utf8");
            const afterCommand = stat.slice(stat.lastIndexOf(")") + 2);
            const parent = Number(afterCommand.split(" ", 2)[1]);
            const pid = Number(name);
            const list = children.get(parent) ?? [];
            list.push(pid);
            children.set(parent, list);
        } catch {
            // The process exited while it was being read.
        }
    }
    const pids = [];
    const pending = [rootPid];
    while (pending.length > 0) {
        const pid = pending.pop();
        pids.push(pid);
        pending.push(...(children.get(pid) ?? []));
    }
    return pids;
}

function socketInodes(pid) {
    const inodes = [];
    let descriptors = [];
    try {
        descriptors = readdirSync(join("/proc", String(pid), "fd"));
    } catch {
        return inodes;
    }
    for (const descriptor of descriptors) {
        try {
            const target = readlinkSync(join("/proc", String(pid), "fd", descriptor));
            const match = /socket:\[(\d+)\]/.exec(target);
            if (match) {
                inodes.push(match[1]);
            }
        } catch {
            // The descriptor closed while it was being read.
        }
    }
    return inodes;
}

function decodeIpv4(hex) {
    const value = Number.parseInt(hex, 16);
    return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff].join(".");
}

function decodeIpv6(hex) {
    const groups = [];
    for (let word = 0; word < 4; word += 1) {
        const chunk = hex.slice(word * 8, word * 8 + 8);
        groups.push(chunk.slice(6, 8) + chunk.slice(4, 6), chunk.slice(2, 4) + chunk.slice(0, 2));
    }
    return groups.join(":");
}

function isLoopback(address) {
    if (address.startsWith("127.")) {
        return true;
    }
    return address.toLowerCase() === "0000:0000:0000:0000:0000:0000:0000:0001";
}

function freePort() {
    return new Promise((resolvePort, rejectPort) => {
        const probe = createServer();
        probe.once("error", rejectPort);
        probe.listen(0, "127.0.0.1", () => {
            const address = probe.address();
            const listenPort = typeof address === "object" && address ? address.port : 0;
            probe.close(() => resolvePort(listenPort));
        });
    });
}

function delay(ms) {
    return new Promise(resolveDelay => {
        setTimeout(resolveDelay, ms);
    });
}

function redact(text) {
    return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[redacted]");
}
