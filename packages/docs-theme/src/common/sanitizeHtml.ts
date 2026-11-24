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

import createDOMPurify, { type Config, type WindowLike } from "dompurify";

const SANITIZE_CONFIG: Config = {
    FORBID_TAGS: ["style"],
};

const URL_ATTRIBUTES = new Set(["action", "background", "formaction", "href", "poster", "src", "srcset", "xlink:href"]);

/** Only image data URLs are allowed, since other media types (e.g. `text/html`) can carry script. */
function isUnsafeDataUrl(value: string): boolean {
    // URL parsers ignore leading C0 control characters and spaces.
    let start = 0;
    while (start < value.length && value.charCodeAt(start) <= 0x20) {
        start++;
    }
    const url = value.slice(start).toLowerCase();
    return url.startsWith("data:") && !url.startsWith("data:image/");
}

/**
 * Creates a function that strips scripts, event handlers, and unsafe URLs from an HTML string.
 * The `window` must provide a DOM implementation (a browser window, or a jsdom window in Node).
 */
export function createHtmlSanitizer(window: WindowLike): (html: string) => string {
    const purify = createDOMPurify(window);
    // DOMPurify returns its input unchanged when it cannot run, so refuse to create an inert sanitizer.
    if (!purify.isSupported) {
        throw new Error("[Blueprint] HTML sanitizer requires a DOM implementation");
    }
    purify.addHook("uponSanitizeAttribute", (_node, data) => {
        if (URL_ATTRIBUTES.has(data.attrName) && isUnsafeDataUrl(data.attrValue)) {
            data.keepAttr = false;
        }
    });
    return html => purify.sanitize(html, SANITIZE_CONFIG);
}

let defaultSanitizer: ((html: string) => string) | undefined;

/**
 * Sanitizes documentation HTML before it is inserted into the page.
 */
export function sanitizeHtml(html: string): string {
    if (defaultSanitizer === undefined) {
        if (typeof window === "undefined") {
            throw new Error("[Blueprint] sanitizeHtml requires a browser window");
        }
        defaultSanitizer = createHtmlSanitizer(window);
    }
    return defaultSanitizer(html);
}
