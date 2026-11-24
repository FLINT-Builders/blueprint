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

// Spec for the dev-server WebSocket memory exhaustion bug.
// These tests fail while webpack-dev-server's ws dependency retains every
// tiny fragment or socket chunk. They pass when a network peer is disconnected
// for crossing the fragment and buffered-chunk limits and the dev server
// process stays up with the retained memory released.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(HERE, "dev-server-ws-fragment-dos.harness.mjs");
const MASK = Buffer.from([0x11, 0x22, 0x33, 0x44]);

// Above the 131072-fragment default added in ws 8.21.0, and far below the
// 100 MiB maxPayload, so a payload-size check cannot be what stops the flood.
const FRAGMENT_COUNT = 200_000;

function lanIPv4() {
    for (const addresses of Object.values(os.networkInterfaces())) {
        for (const address of addresses ?? []) {
            if (address.family === "IPv4" && !address.internal) {
                return address.address;
            }
        }
    }
    return null;
}

function maskedFrame(opcode, payload) {
    const body = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) {
        body[i] = payload[i] ^ MASK[i % MASK.length];
    }
    const lengthByte = 0x80 | payload.length;
    return Buffer.concat([Buffer.from([opcode, lengthByte]), MASK, body]);
}

class FrameParser {
    constructor(socket, initial) {
        this.socket = socket;
        this.buffer = initial ?? Buffer.alloc(0);
        this.frames = [];
        this.ended = false;
        socket.on("data", chunk => {
            this.buffer = Buffer.concat([this.buffer, chunk]);
            this.drain();
        });
        socket.on("close", () => {
            this.ended = true;
        });
        this.drain();
    }

    drain() {
        for (;;) {
            if (this.buffer.length < 2) {
                return;
            }
            const opcode = this.buffer[0] & 0x0f;
            let length = this.buffer[1] & 0x7f;
            let offset = 2;
            if (length === 126) {
                if (this.buffer.length < 4) {
                    return;
                }
                length = this.buffer.readUInt16BE(2);
                offset = 4;
            } else if (length === 127) {
                if (this.buffer.length < 10) {
                    return;
                }
                length = Number(this.buffer.readBigUInt64BE(2));
                offset = 10;
            }
            if (this.buffer.length < offset + length) {
                return;
            }
            const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
            this.buffer = this.buffer.subarray(offset + length);
            this.frames.push({ opcode, payload });
            if (opcode === 0x9) {
                this.socket.write(maskedFrame(0x8a, payload));
            }
        }
    }

    closeFrame() {
        return this.frames.find(frame => frame.opcode === 0x8) ?? null;
    }
}

function connectWebSocket(host, port) {
    const socket = net.connect({ host, port });
    socket.setNoDelay(true);
    return new Promise((resolve, reject) => {
        const onError = error => {
            socket.off("connect", onConnect);
            reject(error);
        };
        const onConnect = () => {
            socket.off("error", onError);
            const key = Buffer.alloc(16, 7).toString("base64");
            let received = Buffer.alloc(0);
            const onData = chunk => {
                received = Buffer.concat([received, chunk]);
                const separator = received.indexOf("\r\n\r\n");
                if (separator === -1) {
                    return;
                }
                socket.off("data", onData);
                const header = received.subarray(0, separator).toString("utf8");
                const rest = received.subarray(separator + 4);
                resolve({
                    header,
                    parser: new FrameParser(socket, rest),
                    socket,
                    status: header.split("\r\n")[0],
                });
            };
            socket.on("data", onData);
            socket.write(
                [
                    "GET /ws HTTP/1.1",
                    `Host: ${host}:${port}`,
                    `Origin: http://${host}:${port}`,
                    "Upgrade: websocket",
                    "Connection: Upgrade",
                    `Sec-WebSocket-Key: ${key}`,
                    "Sec-WebSocket-Version: 13",
                    "",
                    "",
                ].join("\r\n"),
            );
        };
        socket.once("error", onError);
        socket.once("connect", onConnect);
    });
}

function writeAll(socket, chunk) {
    if (socket.destroyed) {
        return Promise.resolve(false);
    }
    const ok = socket.write(chunk);
    if (ok) {
        return Promise.resolve(true);
    }
    return new Promise(resolve => {
        const finish = () => resolve(false);
        socket.once("drain", () => {
            socket.off("close", finish);
            socket.off("error", finish);
            resolve(true);
        });
        socket.once("close", finish);
        socket.once("error", finish);
    });
}

async function withDevServer(run) {
    const child = spawn(process.execPath, ["--expose-gc", HARNESS], {
        cwd: path.resolve(HERE, "../../.."),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => {
        stdout += chunk.toString();
    });
    child.stderr.on("data", chunk => {
        stderr += chunk.toString();
    });
    let exit = null;
    child.on("exit", (code, signal) => {
        exit = { code, signal };
    });

    const listening = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`dev server did not listen\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        }, 30_000);
        child.on("message", message => {
            if (message?.type === "listening") {
                clearTimeout(timer);
                resolve(message);
            }
        });
        child.on("exit", () => {
            clearTimeout(timer);
            reject(new Error(`dev server exited before listening\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        });
    });

    try {
        await run({ child, exit: () => exit, listening, stderr: () => stderr });
    } finally {
        if (exit === null) {
            child.kill("SIGTERM");
            await new Promise(resolve => child.once("exit", resolve));
        }
    }
}

function requestMemory(child) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("dev server did not report memory")), 5_000);
        const onMessage = message => {
            if (message?.type !== "mem") {
                return;
            }
            clearTimeout(timer);
            child.off("message", onMessage);
            resolve(message);
        };
        child.on("message", onMessage);
        child.send({ type: "mem" });
    });
}

async function assertServerSurvived(child, exit, stderr) {
    // Give an unhandled WebSocket error a turn to tear the process down.
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(exit(), null, `dev server process exited while handling a peer's tiny frames\n${stderr()}`);
    assert.equal(child.connected, true);
}

test("a non-local peer cannot exhaust the dev server with tiny WebSocket fragments", { timeout: 60_000 }, async () => {
    const peer = lanIPv4();
    assert.ok(peer, "this environment has no non-loopback IPv4 address to connect from");

    await withDevServer(async ({ child, exit, listening, stderr }) => {
        assert.equal(listening.host, "0.0.0.0");
        assert.equal(listening.allowedHosts, "all");
        assert.equal(listening.address, "0.0.0.0");

        const connection = await connectWebSocket(peer, listening.port);
        assert.equal(connection.status, "HTTP/1.1 101 Switching Protocols");

        const before = await requestMemory(child);
        const first = maskedFrame(0x01, Buffer.from([0x41]));
        const continuation = maskedFrame(0x00, Buffer.from([0x41]));
        await writeAll(connection.socket, first);
        const batchSize = 5_000;
        for (let sent = 1; sent < FRAGMENT_COUNT; sent += batchSize) {
            if (connection.parser.closeFrame() || connection.parser.ended) {
                break;
            }
            const count = Math.min(batchSize, FRAGMENT_COUNT - sent);
            const batch = Buffer.alloc(continuation.length * count);
            for (let index = 0; index < count; index++) {
                continuation.copy(batch, index * continuation.length);
            }
            await writeAll(connection.socket, batch);
        }

        const deadline = Date.now() + 5_000;
        while (!connection.parser.closeFrame() && !connection.parser.ended && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }

        await assertServerSurvived(child, exit, stderr);
        const close = connection.parser.closeFrame();
        assert.ok(close, "dev server left the fragment flood connection open");
        assert.equal(close.payload.readUInt16BE(0), 1008);

        const after = await requestMemory(child);
        const retained = after.heapUsed - before.heapUsed;
        assert.ok(
            retained < 4 * 1024 * 1024,
            `dev server retained ${retained} bytes of heap after a ${FRAGMENT_COUNT}-byte fragment flood`,
        );

        const again = await connectWebSocket(peer, listening.port);
        assert.equal(again.status, "HTTP/1.1 101 Switching Protocols");
        again.socket.destroy();
        connection.socket.destroy();
    });
});
