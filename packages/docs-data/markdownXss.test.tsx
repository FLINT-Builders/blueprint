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

/**
 * Spec for unsanitized documentation HTML.
 *
 * These tests follow the paths that publish package markdown, TypeScript comments,
 * and KSS sections into the docs site, then render that data with the documentation
 * theme. They fail while raw HTML, event handlers, or dangerous URL schemes survive.
 *
 * Covered sinks:
 * - packages/docs-data/markdownRenderer.mjs (shared marked renderer and renderMarkdown)
 * - packages/docs-data/compile-docs-data.mts (Documentalist options and JSON transform)
 * - packages/docs-theme/src/components/block.tsx (page and API comment HTML)
 * - packages/docs-theme/src/components/page.tsx (pages call renderBlock)
 * - packages/docs-theme/src/tags/css.tsx (modifier docs, markup listing, live example)
 * - packages/docs-theme/src/components/example.tsx (KSS markup)
 * - packages/docs-theme/src/components/typescript/deprecatedTag.tsx (deprecation text)
 *
 * Interface, method, enum, and type-alias tables render comment HTML through renderBlock,
 * so they are covered by the renderBlock assertions rather than mounted separately.
 * Heading tags are rendered as React text and are not an HTML sink.
 */

import { Documentalist, KssPlugin, MarkdownPlugin, TypescriptPlugin } from "@documentalist/compiler";
import type { Block } from "@documentalist/client";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { renderBlock } from "../docs-theme/src/components/block";
import { Example } from "../docs-theme/src/components/example";
import { Page } from "../docs-theme/src/components/page";
import { DeprecatedTag } from "../docs-theme/src/components/typescript/deprecatedTag";
import { DocumentationContext, type DocumentationContextApi } from "../docs-theme/src/common/context";
import { CssExample } from "../docs-theme/src/tags/css";
import { transformDocumentalistData } from "./compile-docs-data.mts";
import { hooks, markedRenderer, renderMarkdown } from "./markdownRenderer.mjs";

const HANDLER = "window.__docsXss=1";
const SAFE_LINK = "https://example.com/docs";
const CODE_SAMPLE = "CODE_SAMPLE_ONERROR";

const MARKDOWN_PAGE = `---
title: Attack
---

# Attack

<img src="x" alt="" onerror="${HANDLER}">

See <img src="x" alt="" onerror="${HANDLER}"> inline.

<script>${HANDLER}</script>

<svg onload="${HANDLER}"></svg>

<a href="javascript:${HANDLER}">raw</a>

[markdown](javascript:${HANDLER})

[mixed-case](JaVaScRiPt:${HANDLER})

[data-html](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)

[safe](${SAFE_LINK})

**safe**

\`\`\`"onmouseover="window.__docsXss=1
const copied = "npm install";
\`\`\`

\`\`\`html
<img src="x" onerror="${CODE_SAMPLE}">
\`\`\`
`;

const TYPESCRIPT_SOURCE = `/**
 * Command copied from the docs.
 * <img src="x" alt="" onerror="${HANDLER}">
 * @deprecated <b>old</b> <img src="x" alt="" onerror="${HANDLER}">
 */
export interface CopiedCommand {
    /** <img src="x" alt="" onerror="${HANDLER}"> */
    value: string;
}
`;

const SCSS_SOURCE = `/*
Attack <img src="x" alt="" onerror="${HANDLER}">

[modifier-link](javascript:${HANDLER})

Markup:
<button class="bp6-button">Label</button><img src="x" alt="" onerror="${HANDLER}">

.bp6-intent-danger - modifier <img src="x" alt="" onerror="${HANDLER}">

Styleguide attack.sample
*/
.attack { color: red; }
`;

describe("documentation HTML", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "blueprint-docs-xss-"));
    let docs: Record<string, unknown>;

    beforeAll(async () => {
        writeFileSync(path.join(directory, "_nav.mdx"), "<!-- nav -->\n");
        writeFileSync(path.join(directory, "attack.mdx"), MARKDOWN_PAGE);
        writeFileSync(path.join(directory, "index.ts"), TYPESCRIPT_SOURCE);
        writeFileSync(
            path.join(directory, "tsconfig.json"),
            JSON.stringify({
                compilerOptions: {
                    module: "ESNext",
                    moduleResolution: "bundler",
                    strict: true,
                    target: "ES2022",
                },
                include: ["index.ts"],
            }),
        );
        writeFileSync(path.join(directory, "attack.scss"), SCSS_SOURCE);

        // Same markdown options compile-docs-data passes into Documentalist.
        const documentalist = new Documentalist({
            markdown: {
                hooks,
                renderer: markedRenderer,
            },
            reservedTags: ["import", "ContextMenuTarget", "HotkeysTarget", "param", "returns", "use"],
            sourceBaseDir: directory,
        })
            .use(".mdx", {
                compile: files => files,
            })
            .use(".mdx", new MarkdownPlugin({ navPage: "_nav" }))
            .use(/\.tsx?$/, new TypescriptPlugin({ excludePaths: ["node_modules/"] }))
            .use(".scss", new KssPlugin());

        const generated = await documentalist.documentGlobs(
            path.join(directory, "**/*.mdx"),
            path.join(directory, "**/*.scss"),
            path.join(directory, "index.ts"),
        );
        docs = JSON.parse(JSON.stringify(generated, transformDocumentalistData));
    }, 120_000);

    afterAll(() => {
        rmSync(directory, { recursive: true, force: true });
    });

    it("does not publish active HTML from package markdown", () => {
        const pages = docs.pages as Record<string, { contents: unknown[] }>;
        const attack = pages.attack;
        expect(attack).toBeDefined();

        const view = mount(createElement(Page, { page: attack as never, tagRenderers: headingRenderer() }));
        try {
            expect(view.container.querySelector(`a[href="${SAFE_LINK}"]`)).not.toBeNull();
            expect(view.container.textContent).toContain("safe");
            expect(view.container.textContent).toContain(CODE_SAMPLE);
            expect(problemsInValue(attack.contents)).toEqual([]);
            expect(problemsInNode(view.container)).toEqual([]);
        } finally {
            view.unmount();
        }
    });

    it("does not publish active HTML from documented TypeScript comments", () => {
        const typescript = docs.typescript as Record<string, unknown>;
        const entry = typescript.CopiedCommand as {
            documentation?: Block;
            flags?: { isDeprecated?: boolean | string };
            properties?: Array<{ documentation?: Block; flags?: { isDeprecated?: boolean | string } }>;
        };
        expect(entry).toBeDefined();
        expect(problemsInValue(entry)).toEqual([]);

        const view = mount(
            createElement(
                "div",
                null,
                entry.documentation ? renderBlock(entry.documentation, headingRenderer()) : null,
                ...(entry.properties ?? []).map((property, index) =>
                    createElement(
                        "div",
                        { key: index },
                        property.documentation ? renderBlock(property.documentation, headingRenderer()) : null,
                        typeof property.flags?.isDeprecated === "string"
                            ? createElement(DeprecatedTag, { isDeprecated: property.flags.isDeprecated })
                            : null,
                    ),
                ),
                typeof entry.flags?.isDeprecated === "string"
                    ? createElement(DeprecatedTag, { isDeprecated: entry.flags.isDeprecated })
                    : null,
            ),
        );
        try {
            expect(problemsInNode(view.container)).toEqual([]);
            expect(view.container.textContent).toContain("Command copied from the docs");
        } finally {
            view.unmount();
        }
    });

    it("does not publish active HTML from KSS documentation or example markup", () => {
        const css = (docs.css as Record<string, { reference: string }>) ?? {};
        const section = css["attack.sample"];
        expect(section).toBeDefined();
        expect(problemsInValue(section)).toEqual([]);

        const view = mount(renderCssExample(css, "attack.sample"));
        try {
            expect(problemsInNode(view.container)).toEqual([]);
            expect(view.container.textContent).toContain("Label");
        } finally {
            view.unmount();
        }
    });

    it("does not let renderMarkdown emit active HTML or dangerous URLs", () => {
        const html = renderMarkdown(MARKDOWN_PAGE);
        expect(html).toContain(SAFE_LINK);
        expect(html).toContain(CODE_SAMPLE);
        expect(problemsInHtml(html)).toEqual([]);
    });
});

describe("documentation theme sinks", () => {
    const payload = `<img src="x" alt="" onerror="${HANDLER}"><a href="javascript:${HANDLER}">run</a>`;

    it("renders documentation strings without activating event handlers or javascript URLs", () => {
        const view = mount(renderBlock({ contents: [payload] } as Block, headingRenderer()));
        try {
            expect(problemsInNode(view.container)).toEqual([]);
            expect(view.container.textContent).toContain("run");
        } finally {
            view.unmount();
        }
    });

    it("renders example markup without activating event handlers", () => {
        const previous = Example.defaultProps;
        Example.defaultProps = { ...previous, forceUpdate: false };
        const view = mount(
            createElement(Example, {
                forceUpdate: false,
                html: `<button class="bp6-button">Label</button>${payload}`,
                id: "attack",
                options: false,
            }),
        );
        try {
            expect(problemsInNode(view.container)).toEqual([]);
            expect(view.container.textContent).toContain("Label");
        } finally {
            view.unmount();
            Example.defaultProps = previous;
        }
    });

    it("renders CSS examples without activating documentation, listings, or markup", () => {
        const previous = Example.defaultProps;
        Example.defaultProps = { ...previous, forceUpdate: false };
        const css = {
            "attack.sample": {
                documentation: payload,
                markup: `<button class="bp6-button">Label</button>${payload}`,
                markupHtml: payload,
                modifiers: [{ documentation: payload, name: ".bp6-intent-danger" }],
                reference: "attack.sample",
            },
        };
        const view = mount(renderCssExample(css, "attack.sample"));
        try {
            expect(problemsInNode(view.container)).toEqual([]);
            expect(view.container.textContent).toContain("Label");
        } finally {
            view.unmount();
            Example.defaultProps = previous;
        }
    });

    it("renders deprecation text without activating a second HTML tag", () => {
        const view = mount(createElement(DeprecatedTag, { isDeprecated: `<b>old</b> ${payload}` }));
        try {
            expect(problemsInNode(view.container)).toEqual([]);
            expect(view.container.textContent).toContain("Deprecated:");
            expect(view.container.textContent).toContain("old");
        } finally {
            view.unmount();
        }
    });
});

function headingRenderer() {
    return {
        heading: (props: { value?: string }) => createElement("h2", null, props.value),
    };
}

function renderCssExample(css: object, reference: string): ReactNode {
    const api = {
        getDocsData: () => ({ css, nav: [], pages: {} }),
        renderBlock: (block: Block) => renderBlock(block, headingRenderer()),
        renderType: (type: string) => type,
        renderViewSourceLinkText: () => null,
        showApiDocs: () => undefined,
    } as DocumentationContextApi;
    return createElement(
        DocumentationContext.Provider,
        { value: api },
        createElement(CssExample, { tag: "css", value: reference }),
    );
}

function mount(node: ReactNode): { container: HTMLDivElement; unmount: () => void } {
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root;
    act(() => {
        root = createRoot(container);
        root.render(node);
    });
    return {
        container,
        unmount: () => {
            act(() => {
                root.unmount();
            });
            container.remove();
        },
    };
}

function problemsInValue(value: unknown): string[] {
    if (typeof value === "string") {
        return value.includes("<") ? problemsInHtml(value) : [];
    }
    if (Array.isArray(value)) {
        return value.flatMap(item => problemsInValue(item));
    }
    if (value != null && typeof value === "object") {
        return Object.values(value).flatMap(item => problemsInValue(item));
    }
    return [];
}

function problemsInNode(root: ParentNode): string[] {
    // Reparse the markup the theme inserted. jsdom compiles on* handlers when
    // innerHTML is assigned on a connected element, which is the same parse a
    // browser performs for dangerouslySetInnerHTML.
    const html = root instanceof Element ? root.innerHTML : "";
    return problemsInHtml(html);
}

function problemsInHtml(html: string): string[] {
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.innerHTML = html;
    try {
        return problemsInElements(host.querySelectorAll("*"));
    } finally {
        host.remove();
    }
}

function problemsInElements(elements: NodeListOf<Element>): string[] {
    const problems: string[] = [];
    for (const element of elements) {
        if (element.tagName === "SCRIPT") {
            problems.push(element.outerHTML);
        }
        for (const attribute of element.attributes) {
            const name = attribute.name.toLowerCase();
            if (name.startsWith("on") && attribute.value.trim() !== "") {
                problems.push(`${element.tagName} ${attribute.name}="${attribute.value}"`);
            }
            const dangerousUrl =
                /^\s*(javascript|vbscript):/i.test(attribute.value) || /^\s*data:text\/html/i.test(attribute.value);
            if ((name === "href" || name === "src" || name === "xlink:href" || name === "action") && dangerousUrl) {
                problems.push(`${element.tagName} ${attribute.name}="${attribute.value}"`);
            }
        }
    }
    return problems;
}
