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

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { describe, expect, it } from "@blueprintjs/test-commons/vitest";

import { countDecimalPlaces } from "./jsUtils";
import type { DecimalPlacesProbeRequest } from "./test/decimalPlacesHangProbe.worker";

/**
 * These tests are the spec for the non-terminating decimal counter.
 * They fail while `countDecimalPlaces` spins on a positive step whose
 * scale factor overflows to Infinity, and they pass once that helper
 * returns 0 for those steps so slider and numeric-input render can finish.
 *
 * A parent thread kills each probe. An infinite loop on the test thread
 * would never reach the assertion.
 */

interface ProbeOk {
    status: "ok";
    value: unknown;
}

interface ProbeThrew {
    message: string;
    status: "threw";
}

interface ProbeHung {
    status: "hung";
}

type ProbeResult = ProbeOk | ProbeThrew | ProbeHung;

// Vitest rewrites import.meta.url, so locate the probe from the package directory.
const WORKER_SOURCE = [
    path.resolve(process.cwd(), "src/common/utils/test/decimalPlacesHangProbe.worker.ts"),
    path.resolve(process.cwd(), "packages/core/src/common/utils/test/decimalPlacesHangProbe.worker.ts"),
].find(candidate => existsSync(candidate));

if (WORKER_SOURCE == null) {
    throw new Error("decimalPlacesHangProbe.worker.ts was not found");
}
// Keep the bundle inside this package so Node can resolve react and the other
// workspace dependencies from packages/core/node_modules. coverage/ is gitignored.
const BUNDLED_WORKER = path.resolve(path.dirname(WORKER_SOURCE), "../../../coverage/decimal-places-probe.mjs");

function findPackageDir(folderPrefix: string): string {
    let dir = path.dirname(WORKER_SOURCE);
    const packageName = folderPrefix.slice(0, folderPrefix.indexOf("@"));
    while (dir !== path.dirname(dir)) {
        const pnpmDir = path.join(dir, "node_modules", ".pnpm");
        try {
            const entry = readdirSync(pnpmDir).find(name => name.startsWith(folderPrefix));
            if (entry != null) {
                return path.join(pnpmDir, entry, "node_modules", packageName);
            }
        } catch {
            // This directory is not the workspace root.
        }
        dir = path.dirname(dir);
    }
    throw new Error(`${packageName} was not found. Run pnpm install before these tests.`);
}

// Bundle the probe from this repo's TypeScript so the worker executes the
// component sources. Package imports stay external and resolve to the installed copies.
// esbuild refuses to load inside Vitest's jsdom environment, so build in a child process.
function bundleProbe(): void {
    const esbuildPackage = findPackageDir("esbuild@0.27.");
    const script = `
        const { createRequire } = require("node:module");
        const { mkdirSync } = require("node:fs");
        const path = require("node:path");
        const esbuild = createRequire(path.join(${JSON.stringify(esbuildPackage)}, "package.json"))("esbuild");
        const outfile = ${JSON.stringify(BUNDLED_WORKER)};
        mkdirSync(path.dirname(outfile), { recursive: true });
        esbuild.buildSync({
            bundle: true,
            entryPoints: [${JSON.stringify(WORKER_SOURCE)}],
            format: "esm",
            jsx: "automatic",
            outfile,
            packages: "external",
            platform: "node",
            target: "node22",
        });
    `;
    const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
    if (result.status !== 0) {
        throw new Error(`Failed to bundle the decimal-places probe.\n${result.stderr}`);
    }
}

bundleProbe();

async function runProbe(request: DecimalPlacesProbeRequest, timeoutMs: number): Promise<ProbeResult> {
    // Drop the parent process's CLI flags. Vitest's loader flags, and an
    // inherited --input-type, make the bundled worker fail before the probe.
    const worker = new Worker(BUNDLED_WORKER, {
        execArgv: [],
        workerData: request,
    });
    let stderr = "";
    worker.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
    });

    return new Promise(resolve => {
        const timer = setTimeout(() => {
            void worker.terminate();
            resolve({ status: "hung" });
        }, timeoutMs);
        worker.once("message", (message: ProbeOk | ProbeThrew) => {
            clearTimeout(timer);
            void worker.terminate();
            resolve(message);
        });
        worker.once("error", (error: Error) => {
            clearTimeout(timer);
            void worker.terminate();
            resolve({
                message: stderr === "" ? error.message : `${error.message}\n${stderr}`,
                status: "threw",
            });
        });
    });
}

const COUNT_TIMEOUT_MS = 2500;
const COMPONENT_TIMEOUT_MS = 5000;

async function expectCount(step: number, expected: number) {
    const result = await runProbe({ op: "count", step }, COUNT_TIMEOUT_MS);
    expect(result.status, JSON.stringify(result)).toBe("ok");
    if (result.status === "ok") {
        expect(result.value).toBe(expected);
    }
}

async function expectSliderPrecision(step: number, expected: number) {
    const result = await runProbe({ op: "slider-derived", step }, COMPONENT_TIMEOUT_MS);
    expect(result.status, JSON.stringify(result)).toBe("ok");
    if (result.status === "ok") {
        expect(result.value).toEqual({ labelPrecision: expected });
    }
}

async function expectNumericPrecision(request: Omit<DecimalPlacesProbeRequest, "op">, expected: number) {
    const result = await runProbe({ ...request, op: "numeric-derived" }, COMPONENT_TIMEOUT_MS);
    expect(result.status, JSON.stringify(result)).toBe("ok");
    if (result.status === "ok") {
        expect(result.value).toMatchObject({ stepMaxPrecision: expected });
    }
}

/** Mount and prop updates must return. Validation may throw; spinning may not. */
async function expectSettles(request: DecimalPlacesProbeRequest) {
    const result = await runProbe(request, COMPONENT_TIMEOUT_MS);
    expect(result.status, JSON.stringify(result)).not.toBe("hung");
    if (result.status === "ok" && request.op === "render") {
        expect((result.value as { htmlLength: number }).htmlLength).toBeGreaterThan(0);
    }
    if (result.status === "ok" && request.op === "update") {
        expect((result.value as { htmlLength: number }).htmlLength).toBeGreaterThan(0);
    }
}

describe("countDecimalPlaces termination", () => {
    // Ordinary values still take the existing finite path. These stay on the
    // test thread because they return immediately.
    it("counts ordinary finite steps", () => {
        expect(countDecimalPlaces(1)).toBe(0);
        expect(countDecimalPlaces(0.11)).toBe(2);
        expect(countDecimalPlaces(-1.1111111111)).toBe(10);
        expect(countDecimalPlaces(1e-10)).toBe(10);
        expect(countDecimalPlaces(0)).toBe(0);
    });

    it("returns zero decimal places for non-finite values", () => {
        expect(countDecimalPlaces(Number.NaN)).toBe(0);
        expect(countDecimalPlaces(Number.POSITIVE_INFINITY)).toBe(0);
        expect(countDecimalPlaces(Number.NEGATIVE_INFINITY)).toBe(0);
    });

    // Number.MIN_VALUE and 1e-305 are both greater than zero, so slider and
    // numeric-input validation accept them. 1e-305 is still a normal float;
    // treating only subnormals as safe would leave this loop in place.
    it("returns zero for the smallest positive float", async () => {
        await expectCount(Number.MIN_VALUE, 0);
    });

    it("returns zero for the smallest negative float", async () => {
        await expectCount(-Number.MIN_VALUE, 0);
    });

    it("returns zero for a positive normal whose decimal scale overflows", async () => {
        await expectCount(1e-305, 0);
    });

    it("returns zero for a negative normal whose decimal scale overflows", async () => {
        await expectCount(-1e-305, 0);
    });
});

describe("MultiSlider label precision derived from stepSize", () => {
    it("keeps an explicit labelPrecision without counting a tiny step", async () => {
        const result = await runProbe(
            { labelPrecision: 2, op: "slider-derived", step: Number.MIN_VALUE },
            COMPONENT_TIMEOUT_MS,
        );
        expect(result.status, JSON.stringify(result)).toBe("ok");
        if (result.status === "ok") {
            expect(result.value).toEqual({ labelPrecision: 2 });
        }
    });

    it("derives precision 0 for Number.MIN_VALUE", async () => {
        await expectSliderPrecision(Number.MIN_VALUE, 0);
    });

    it("derives precision 0 for 1e-305", async () => {
        await expectSliderPrecision(1e-305, 0);
    });

    it("derives precision 0 for a negative denormal step", async () => {
        // getDerivedStateFromProps does not consult validateProps. Repeating
        // the stepSize <= 0 check only inside the constructor still leaves this update path spinning.
        await expectSliderPrecision(-Number.MIN_VALUE, 0);
    });
});

describe("NumericInput step precision", () => {
    it("derives precision 0 from a denormal minorStepSize", async () => {
        await expectNumericPrecision({ includeMinorStepSize: true, minorStepSize: Number.MIN_VALUE, step: 1 }, 0);
    });

    it("derives precision 0 from a denormal stepSize when minor steps are disabled", async () => {
        // minorStepSize={null} is the documented way to disable alt-increment.
        // The default minor step is 0.1, so a denormal stepSize is only read
        // after that prop is explicitly null.
        await expectNumericPrecision({ includeMinorStepSize: true, minorStepSize: null, step: Number.MIN_VALUE }, 0);
    });

    it("derives precision 0 from a negative denormal minorStepSize", async () => {
        await expectNumericPrecision({ includeMinorStepSize: true, minorStepSize: -Number.MIN_VALUE, step: 1 }, 0);
    });

    it("derives precision 0 from minorStepSize 1e-305", async () => {
        await expectNumericPrecision({ includeMinorStepSize: true, minorStepSize: 1e-305, step: 1 }, 0);
    });

    it("derives precision 0 while validating a controlled value", async () => {
        await expectNumericPrecision(
            { includeMinorStepSize: true, minorStepSize: Number.MIN_VALUE, step: 1, value: 1 },
            0,
        );
    });
});

describe("render path", () => {
    it("renders an ordinary slider", async () => {
        const result = await runProbe({ component: "Slider", op: "render", step: 0.2 }, COMPONENT_TIMEOUT_MS);
        expect(result.status, JSON.stringify(result)).toBe("ok");
        if (result.status === "ok") {
            expect((result.value as { htmlLength: number }).htmlLength).toBeGreaterThan(0);
        }
    });

    it("mounts MultiSlider with a denormal stepSize", async () => {
        await expectSettles({ component: "MultiSlider", op: "render", step: Number.MIN_VALUE });
    });

    it("mounts Slider with a denormal stepSize", async () => {
        await expectSettles({ component: "Slider", op: "render", step: Number.MIN_VALUE });
    });

    it("mounts RangeSlider with a denormal stepSize", async () => {
        await expectSettles({ component: "RangeSlider", op: "render", step: Number.MIN_VALUE });
    });

    it("mounts Slider with stepSize 1e-305", async () => {
        await expectSettles({ component: "Slider", op: "render", step: 1e-305 });
    });

    it("mounts NumericInput with a denormal minorStepSize", async () => {
        await expectSettles({
            component: "NumericInput",
            includeMinorStepSize: true,
            minorStepSize: Number.MIN_VALUE,
            op: "render",
            step: 1,
        });
    });

    it("mounts NumericInput with a denormal stepSize and minor steps disabled", async () => {
        await expectSettles({
            component: "NumericInput",
            includeMinorStepSize: true,
            minorStepSize: null,
            op: "render",
            step: Number.MIN_VALUE,
        });
    });

    it("mounts a controlled NumericInput whose validation reads the denormal minor step", async () => {
        await expectSettles({
            component: "NumericInput",
            includeMinorStepSize: true,
            minorStepSize: Number.MIN_VALUE,
            op: "render",
            step: 1,
            value: 1,
        });
    });

    it("updates MultiSlider from a safe step to a denormal step", async () => {
        await expectSettles({
            component: "MultiSlider",
            nextStep: Number.MIN_VALUE,
            op: "update",
            step: 1,
        });
    });

    it("updates Slider from a safe step to stepSize 1e-305", async () => {
        await expectSettles({
            component: "Slider",
            nextStep: 1e-305,
            op: "update",
            step: 1,
        });
    });

    it("updates RangeSlider from a safe step to a denormal step", async () => {
        await expectSettles({
            component: "RangeSlider",
            nextStep: Number.MIN_VALUE,
            op: "update",
            step: 1,
        });
    });

    it("updates NumericInput to a denormal minorStepSize", async () => {
        await expectSettles({
            component: "NumericInput",
            includeMinorStepSize: true,
            includeNextMinorStepSize: true,
            minorStepSize: 0.1,
            nextMinorStepSize: Number.MIN_VALUE,
            nextStep: 1,
            op: "update",
            step: 1,
        });
    });

    it("updates NumericInput to a denormal stepSize with minor steps disabled", async () => {
        await expectSettles({
            component: "NumericInput",
            includeMinorStepSize: true,
            includeNextMinorStepSize: true,
            minorStepSize: 0.1,
            nextMinorStepSize: null,
            nextStep: Number.MIN_VALUE,
            op: "update",
            step: 1,
        });
    });
});
