/**
 * @vitest-environment jsdom
 */

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

import { Documentalist, KssPlugin, MarkdownPlugin, TypescriptPlugin } from "@documentalist/compiler";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { transformDocumentalistData } from "./compile-docs-data.mts";
import { hooks, markedRenderer, renderMarkdown } from "./markdownRenderer.mjs";

/**
 * Fence info string with no whitespace. Marked keeps this as the language token.
 * The quote closes data-lang, the following markup is parsed as an element with an event handler.
 */
const BREAKOUT_LANGUAGE = `"></pre><svg/onload=window.__xss=1>`;

const markdownOptions = { hooks, renderer: markedRenderer };
const reservedTags = ["import", "ContextMenuTarget", "HotkeysTarget", "param", "returns", "use"];

function fence(language: string, body: string): string {
    return "```" + language + "\n" + body + "\n```\n";
}

function expectLanguageCannotInjectMarkup(html: string): void {
    const host = document.createElement("div");
    host.innerHTML = html;
    expect(host.querySelector("svg")).toBeNull();
    expect(host.querySelector("[onload], [onerror], [ontoggle]")).toBeNull();
    expect(html.includes(BREAKOUT_LANGUAGE)).toBe(false);
}

function store<T>(value: T): T {
    return JSON.parse(JSON.stringify(value, transformDocumentalistData)) as T;
}

describe("fenced code language HTML", () => {
    it("does not inject markup from an MDX fence language into a documentation page", async () => {
        const root = mkdtempSync(join(tmpdir(), "fence-page-"));
        try {
            writeFileSync(join(root, "_nav.mdx"), "---\nreference: _nav\n---\n\n# Nav\n\n@page attack\n");
            writeFileSync(
                join(root, "attack.mdx"),
                `---\nreference: attack\n---\n\n# Attack\n\n${fence(BREAKOUT_LANGUAGE, 'const value = "<b>body</b>";')}\n`,
            );
            const docs = await new Documentalist({
                markdown: markdownOptions,
                reservedTags,
                sourceBaseDir: root,
            })
                .use(".mdx", {
                    compile: files =>
                        process.platform === "win32" ? files.map(file => file.read().replace(/\r\n/g, "\n")) : files,
                })
                .use(".mdx", new MarkdownPlugin({ navPage: "_nav" }))
                .documentGlobs(join(root, "*.mdx"));
            const page = store(docs).pages.attack;
            const html = page.contents.filter((node: unknown) => typeof node === "string").join("\n");
            expect(html).toContain("&lt;b&gt;");
            expectLanguageCannotInjectMarkup(html);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("does not inject markup when the fence language is followed by the copy flag", async () => {
        const html = renderMarkdown(fence(`${BREAKOUT_LANGUAGE} copy`, "import x from 'y';"));
        expect(html).toContain("docs-copyable-import");
        expectLanguageCannotInjectMarkup(html);
    });

    it("does not inject markup from a KSS modifier description", async () => {
        const root = mkdtempSync(join(tmpdir(), "fence-kss-"));
        try {
            writeFileSync(
                join(root, "attack.scss"),
                [
                    "// Button",
                    "//",
                    "// Markup:",
                    '// <button class="{{.modifier}}">x</button>',
                    "//",
                    "// .danger - ```" + BREAKOUT_LANGUAGE,
                    "//",
                    "// Styleguide buttons.attack",
                    "",
                ].join("\n"),
            );
            const docs = await new Documentalist({
                markdown: markdownOptions,
                reservedTags,
                sourceBaseDir: root,
            })
                .use(".scss", new KssPlugin())
                .documentGlobs(join(root, "*.scss"));
            const modifier = store(docs).css["buttons.attack"].modifiers[0];
            expectLanguageCannotInjectMarkup(modifier.documentation);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("does not inject markup from a TypeScript doc comment fence", async () => {
        const root = mkdtempSync(join(tmpdir(), "fence-ts-"));
        try {
            writeFileSync(
                join(root, "tsconfig.json"),
                JSON.stringify({
                    compilerOptions: { strict: true, target: "ES2022", module: "ESNext", skipLibCheck: true },
                    include: ["index.ts"],
                }),
            );
            writeFileSync(
                join(root, "index.ts"),
                `/**\n * Before\n *\n * \`\`\`${BREAKOUT_LANGUAGE}\n * const value = 1;\n * \`\`\`\n */\nexport function attacked(): void {}\n`,
            );
            const docs = await new Documentalist({
                markdown: markdownOptions,
                reservedTags,
                sourceBaseDir: root,
            })
                .use(
                    /\.tsx?$/,
                    new TypescriptPlugin({ excludeNames: [/.+State$/], excludePaths: ["node_modules/"] }),
                )
                .documentGlobs(join(root, "index.ts"));
            const html = store(docs).typescript.attacked.signatures[0].documentation.contents.join("\n");
            expectLanguageCannotInjectMarkup(html);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("keeps a normal language token in data-lang", () => {
        const html = renderMarkdown(fence("tsx copy", 'const value = "<b>ok</b>";'));
        expect(html).toContain('data-lang="typescript"');
        expect(html).toContain("&lt;b&gt;");
        expectLanguageCannotInjectMarkup(html);
    });
});
