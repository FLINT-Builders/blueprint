/**
 * Copyright 2026 Palantir Technologies, Inc. All rights reserved.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sass from "sass";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { sassCompileFile } from "./sassCompileFile.mjs";
import { sassSvgInlinerFactory } from "./sassSvgInliner.mjs";

const INSIDE_MARKER = "MARKER_INSIDE_ICON";
const OUTSIDE_MARKER = "MARKER_OUTSIDE_FILE";

/**
 * svg-icon() is registered for every stylesheet compiled by sass-compile, including stylesheets
 * reached through @use. The path argument is resolved against resources/icons and must not be
 * allowed to leave that directory. These tests fail while an absolute path, a parent-directory
 * path, or a symlink inside the directory can still be opened.
 */
describe("svg-icon path containment", () => {
    let root: string;
    let iconsDir: string;
    let outsideDir: string;
    let workDir: string;
    let previousCwd: string;
    const originalConsoleError = console.error;

    beforeEach(() => {
        previousCwd = process.cwd();
        root = mkdtempSync(join(tmpdir(), "svg-icon-containment-"));
        iconsDir = join(root, "resources", "icons");
        outsideDir = join(root, "outside");
        // sassCustomFunctions resolves "../../resources/icons" from the process cwd.
        workDir = join(root, "pkg", "nested");
        mkdirSync(join(iconsDir, "16px"), { recursive: true });
        mkdirSync(join(workDir, "src"), { recursive: true });
        mkdirSync(outsideDir, { recursive: true });
        writeFileSync(join(iconsDir, "16px", "ok.svg"), svgDocument(INSIDE_MARKER));
        writeFileSync(join(outsideDir, "secret.svg"), svgDocument(OUTSIDE_MARKER));
        symlinkSync(join(outsideDir, "secret.svg"), join(iconsDir, "alias.svg"));
        execFileSync("mkfifo", [join(outsideDir, "escape.fifo")]);
        process.chdir(workDir);
        console.error = () => undefined;
    });

    afterEach(() => {
        console.error = originalConsoleError;
        process.chdir(previousCwd);
        rmSync(root, { force: true, recursive: true });
    });

    test("inlines an icon that stays inside the icons directory", async () => {
        const css = await compileScss(iconCall("16px/ok.svg"));

        expect(css).toContain(INSIDE_MARKER);
        expect(css).not.toContain(OUTSIDE_MARKER);
    });

    test("inlines a relative path that normalizes back inside the icons directory", async () => {
        const css = await compileScss(iconCall("16px/../16px/ok.svg"));

        expect(css).toContain(INSIDE_MARKER);
    });

    test("rejects an absolute path before opening the file", async () => {
        const fifo = join(outsideDir, "escape.fifo");
        const { error, opened } = await compileWhileWatching(iconCall(fifo), fifo);

        expect(error).toBeInstanceOf(Error);
        expect(opened).toBe(false);
    });

    test("rejects an absolute path that points at a file inside the icons directory", async () => {
        const { error, css } = await compileResult(iconCall(join(iconsDir, "16px", "ok.svg")));

        expect(error).toBeInstanceOf(Error);
        expect(css).not.toContain(INSIDE_MARKER);
    });

    test("rejects a parent-directory path before opening the file", async () => {
        const fifo = join(outsideDir, "escape.fifo");
        const { error, opened } = await compileWhileWatching(iconCall("../../outside/escape.fifo"), fifo);

        expect(error).toBeInstanceOf(Error);
        expect(opened).toBe(false);
    });

    test("does not embed an svg reached by a path that normalizes outside the icons directory", async () => {
        const { error, css } = await compileResult(iconCall("16px/../../../outside/secret.svg"));

        expect(error).toBeInstanceOf(Error);
        expect(css).not.toContain(OUTSIDE_MARKER);
    });

    test("does not follow a symlink inside the icons directory to a file outside it", async () => {
        const { error, css } = await compileResult(iconCall("alias.svg"));

        expect(error).toBeInstanceOf(Error);
        expect(css).not.toContain(OUTSIDE_MARKER);
    });

    test("rejects a traversal path supplied by an imported stylesheet before opening the file", async () => {
        const fifo = join(outsideDir, "escape.fifo");
        writeFileSync(join(workDir, "src", "_leak.scss"), iconCall("../../outside/escape.fifo"));
        const { error, opened } = await compileWhileWatching('@use "leak";\n', fifo);

        expect(error).toBeInstanceOf(Error);
        expect(opened).toBe(false);
    });

    test("factory rejects an absolute plaintext path before opening it", async () => {
        const fifo = join(outsideDir, "escape.fifo");
        const inline = sassSvgInlinerFactory(iconsDir, { encodingFormat: "uri", optimize: false });
        const { error, opened } = await runWhileWatching(
            () => Promise.resolve(inline([new sass.SassString(fifo)])),
            fifo,
        );

        expect(error).toBeInstanceOf(Error);
        expect(opened).toBe(false);
    });

    test("factory rejects a relative plaintext path that leaves the base directory before opening it", async () => {
        const fifo = join(outsideDir, "escape.fifo");
        const inline = sassSvgInlinerFactory(iconsDir, { encodingFormat: "base64", optimize: false });
        const { error, opened } = await runWhileWatching(
            () => Promise.resolve(inline([new sass.SassString("../../outside/escape.fifo")])),
            fifo,
        );

        expect(error).toBeInstanceOf(Error);
        expect(opened).toBe(false);
    });

    test("factory rejects an absolute svg path when optimization is enabled", async () => {
        const inline = sassSvgInlinerFactory(iconsDir, { encodingFormat: "uri", optimize: true });
        const { error, value } = await callResult(() =>
            Promise.resolve(inline([new sass.SassString(join(outsideDir, "secret.svg"))])),
        );

        expect(error).toBeInstanceOf(Error);
        expect(value).not.toContain(OUTSIDE_MARKER);
    });

    test("factory still inlines an icon inside the configured base", async () => {
        const inline = sassSvgInlinerFactory(iconsDir, { encodingFormat: "uri", optimize: true });
        const value = await inline([new sass.SassString("16px/ok.svg")]);

        expect(value.toString()).toContain(INSIDE_MARKER);
        expect(value.toString()).not.toContain(OUTSIDE_MARKER);
    });
});

function svgDocument(marker: string): string {
    return `<svg xmlns="http://www.w3.org/2000/svg"><text>${marker}</text><path d="M1 2h3" fill="#010203"/></svg>`;
}

function iconCall(iconPath: string): string {
    return `a { background: svg-icon("${iconPath}", (path: (fill: #fff))); }\n`;
}

async function compileScss(source: string): Promise<string> {
    const { error, css } = await compileResult(source);
    if (error) {
        throw error;
    }
    return css;
}

async function compileResult(source: string): Promise<{ error: unknown; css: string }> {
    const input = join(process.cwd(), "src", "entry.scss");
    writeFileSync(input, source);
    const outputDir = join(process.cwd(), "out");
    mkdirSync(outputDir, { recursive: true });
    try {
        await sassCompileFile(input, outputDir, undefined);
        return { css: readFileSync(join(outputDir, "entry.css"), "utf8"), error: undefined };
    } catch (error) {
        return { css: readCompiledCss(), error };
    }
}

async function callResult(
    operation: () => Promise<{ toString: () => string }>,
): Promise<{ error: unknown; value: string }> {
    try {
        const result = await operation();
        return { error: undefined, value: result.toString() };
    } catch (error) {
        return { error, value: "" };
    }
}

function readCompiledCss(): string {
    const output = join(process.cwd(), "out", "entry.css");
    try {
        return readFileSync(output, "utf8");
    } catch {
        return "";
    }
}

/**
 * readFileSync blocks the event loop on a FIFO until another process connects a writer.
 * That writer records whether the inliner opened the path. A check that still opens the
 * path, including one that looks the path up and then opens it again, fails this probe.
 */
async function compileWhileWatching(source: string, fifo: string): Promise<{ error: unknown; opened: boolean }> {
    return runWhileWatching(() => compileScss(source), fifo);
}

async function runWhileWatching(
    operation: () => Promise<unknown>,
    fifo: string,
): Promise<{ error: unknown; opened: boolean }> {
    const probe = startFifoProbe(fifo);
    let error: unknown;
    try {
        await operation();
    } catch (caught) {
        error = caught;
    }
    probe.stop();
    return { error, opened: await probe.opened };
}

function startFifoProbe(fifo: string): { stop: () => void; opened: Promise<boolean> } {
    const child = spawn(
        process.execPath,
        [
            "-e",
            `
            const fs = require("node:fs");
            const fifo = process.argv[1];
            const deadline = Date.now() + 3000;
            while (Date.now() < deadline) {
                try {
                    const fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
                    fs.writeSync(fd, "opened");
                    fs.closeSync(fd);
                    process.exit(0);
                } catch (error) {
                    if (error.code !== "ENXIO" && error.code !== "ENOENT") process.exit(2);
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
                }
            }
            process.exit(1);
            `,
            fifo,
        ],
        { stdio: "ignore" },
    );
    let opened = false;
    const done = new Promise<boolean>(resolve => {
        child.on("exit", code => {
            opened = code === 0;
            resolve(opened);
        });
    });
    return {
        opened: done,
        stop() {
            child.kill();
        },
    };
}
