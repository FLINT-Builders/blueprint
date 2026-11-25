/*
 * (c) Copyright 2023 Palantir Technologies Inc. All rights reserved.
 */

/**
 * @fileoverview adapted from a fork of sass-inline-svg which implements dart-sass support
 * @see https://github.com/Liquid-JS/sass-inline-svg/blob/958bd0e27782d46349da7d8a831467257d4130d1/index.js
 */

// @ts-check

import selectAll, { selectOne } from "css-select";
import serialize from "dom-serializer";
import { parseDocument } from "htmlparser2";
import svgToDataUri from "mini-svg-data-uri";
import {
    closeSync,
    constants as fsConstants,
    fstatSync,
    openSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    statSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import * as sass from "sass";
import { optimize as svgoOptimize } from "svgo";

/** macOS open(2) flag which refuses symlinks in any component of the path, see <sys/fcntl.h>. */
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;

/* eslint-disable no-bitwise -- open(2) flags are a bitmask */
const OPEN_FLAGS =
    fsConstants.O_RDONLY |
    (fsConstants.O_NOFOLLOW ?? 0) |
    (fsConstants.O_NONBLOCK ?? 0) |
    (process.platform === "darwin" ? DARWIN_O_NOFOLLOW_ANY : 0);
/* eslint-enable no-bitwise */

/**
 * The SVG inliner function.
 * This is a factory that expects a base path and returns the actual function.
 *
 * @param {string} base
 * @param {{optimize: boolean, encodingFormat: string}} opts
 * @returns {sass.CustomFunction<"async">}
 */
export function sassSvgInlinerFactory(base, opts) {
    const { optimize = false, encodingFormat = "base64" } = opts;

    /**
     * @param {sass.Value[]} args
     * @returns {Promise<sass.SassString>}
     */
    return async function (args) {
        const path = /** @type {sass.SassString} */ (args[0]);
        const selectors = /** @type {sass.SassMap | undefined} */ (args[1]);
        const { realPath: resolvedPath, contents } = readFileInsideBase(base, path.text);
        try {
            let svgContents = contents;

            if (selectors !== undefined && selectors.asList.size > 0) {
                svgContents = changeStyle(svgContents, selectors);
            }

            if (optimize) {
                svgContents = svgoOptimize(svgContents, { path: resolvedPath }).data;
            }

            return encode(svgContents, { encodingFormat });
        } catch (err) {
            console.error("[node-build-scripts]", err);
            return new sass.SassString("");
        }
    };
}

/**
 * Reads `requested` relative to `base`, refusing any path (lexically or through symlinks) that resolves
 * outside of `base`. Path lookups can be raced by swapping a directory for a symlink, so the containment
 * check is repeated against the file descriptor that was actually opened before anything is read from it.
 *
 * @param {string} base
 * @param {string} requested
 * @returns {{ realPath: string, contents: string }}
 */
function readFileInsideBase(base, requested) {
    if (isAbsolute(requested)) {
        throw new Error(`[node-build-scripts] svg-icon path must be relative to the icons directory: ${requested}`);
    }
    const lexicalPath = resolve(base, requested);
    if (!isPathInside(resolve(base), lexicalPath)) {
        throw new Error(`[node-build-scripts] svg-icon path escapes the icons directory: ${requested}`);
    }

    const realBase = realpathSync(base);
    const realPath = realpathSync(lexicalPath);
    if (!isPathInside(realBase, realPath)) {
        throw new Error(`[node-build-scripts] svg-icon path escapes the icons directory: ${requested}`);
    }
    const expected = statSync(realPath);
    if (!expected.isFile()) {
        throw new Error(`[node-build-scripts] svg-icon path is not a regular file: ${requested}`);
    }

    const fd = openSync(realPath, OPEN_FLAGS);
    try {
        const actual = fstatSync(fd);
        if (
            !actual.isFile() ||
            actual.dev !== expected.dev ||
            actual.ino !== expected.ino ||
            !isPathInside(realBase, getOpenedFilePath(fd, realPath))
        ) {
            throw new Error(`[node-build-scripts] svg-icon path changed while it was being read: ${requested}`);
        }
        return { contents: readFileSync(fd, { encoding: "utf8" }), realPath };
    } finally {
        closeSync(fd);
    }
}

/**
 * @param {number} fd
 * @param {string} openedPath the symlink-free path that `fd` was opened from
 * @returns {string} the path of the file the kernel opened for `fd`
 */
function getOpenedFilePath(fd, openedPath) {
    if (process.platform === "linux") {
        return readlinkSync(`/proc/self/fd/${fd}`);
    }
    // On macOS, O_NOFOLLOW_ANY guarantees that no symlink in `openedPath` was followed. Other platforms
    // (e.g. Windows) expose no descriptor-to-path lookup to Node, and rely on the dev/ino comparison.
    return openedPath;
}

/**
 * @param {string} parent absolute, normalized directory path
 * @param {string} child absolute, normalized path
 * @returns {boolean} whether `child` is strictly inside `parent`
 */
function isPathInside(parent, child) {
    const rel = relative(parent, child);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Encode a JS string as a Sass string.
 *
 * @param {any} content
 * @param {any} opts
 * @returns {sass.SassString}
 */
function encode(content, opts) {
    if (opts.encodingFormat === "uri") {
        return new sass.SassString(`url("${svgToDataUri(content.toString("UTF-8"))}")`, { quotes: false });
    }

    if (opts.encodingFormat === "base64") {
        const base64 = Buffer.from(content.toString(), "utf8").toString("base64");
        return new sass.SassString(`url("data:image/svg+xml;base64,${base64}")`, { quotes: false });
    }

    throw new Error(`[node-build-scripts] encodingFormat ${opts.encodingFormat} is not supported`);
}

/**
 * Change the style attributes of an SVG string.
 *
 * @param {string} source
 * @param {sass.SassMap} selectorsMap
 * @returns {*}
 */
function changeStyle(source, selectorsMap) {
    const document = parseDocument(source, {
        xmlMode: true,
    });
    const svg = document ? selectOne("svg", document.childNodes) : null;

    const selectors = mapToObj(selectorsMap);

    if (!svg) {
        throw Error("[node-build-scripts] Invalid svg file");
    }

    Object.keys(selectors).forEach(function (selector) {
        const elements = selectAll(selector, svg);
        const newAttributes = selectors[selector];

        elements.forEach(function (element) {
            // @ts-ignore -- attribs property does exist
            Object.assign(element.attribs, newAttributes);
        });
    });

    return serialize(document);
}

/**
 * Recursively transforms a Sass map into a JS object.
 *
 * @param {sass.SassMap} sassMap
 * @returns {Record<any, any>}
 */
function mapToObj(sassMap) {
    const obj = Object.create(null);
    const map = sassMap.contents.toJS();

    for (const [key, value] of /** @type {[string, sass.Value][]} */ (Object.entries(map))) {
        obj[key] = value instanceof sass.SassMap ? mapToObj(value) : value.toString();
    }

    return obj;
}
