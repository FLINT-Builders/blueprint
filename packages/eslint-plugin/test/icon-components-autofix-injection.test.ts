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

import { ESLint, type Linter } from "eslint";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { iconComponentsRule, OPTION_COMPONENT, OPTION_LITERAL } from "../src/rules/icon-components";

const require = createRequire(__filename);
const requireFromTslintConfig = createRequire(path.resolve(__dirname, "../../tslint-config/package.json"));
const tslint = requireFromTslintConfig("tslint") as {
    Linter: {
        new (options: { fix: boolean; rulesDirectory: string }): {
            lint(fileName: string, source: string, configuration: unknown): void;
            getResult(): { errorCount: number };
        };
        loadConfigurationFromPath(configPath: string): unknown;
    };
};
const typescriptEslintParser = require(
    require.resolve("@typescript-eslint/parser", {
        paths: [require.resolve("@typescript-eslint/rule-tester/package.json")],
    }),
) as Linter.Parser;

/**
 * Payloads are the characters inside the icon attribute quotes.
 * The first is the reported breakout. The second spells Function by putting a hyphen
 * before the capital F. The third hides that call behind a lowercase hex escape, which
 * survives the rule's lowercasing and is decoded only after the fixer writes it into source.
 */
const CALLED_PAYLOAD = "object icon/>&&alert(document.domain)||<y";
const FUNCTION_PAYLOAD = "object icon/>&&-function('alert(document.domain)')()||<y";
const HEX_PAYLOAD = "object icon/>&&-function('\\x61lert(document.domain)')()||<y";
/** Espree decodes this to "tick"; the raw characters are not an identifier. */
const ENTITY_NAME = "t&#105;ck";
/** Espree decodes this to the breakout payload; the raw characters are entity text. */
const ENTITY_PAYLOAD = "object&#32;icon/&#62;&#38;&#38;alert(document.domain)||&#60;y";

type ParserKind = "espree" | "typescript-eslint";

interface FixCase {
    label: string;
    parser: ParserKind;
    ruleConfig: Linter.RuleEntry;
    quote: '"' | "'";
    payload: string;
}

const parsers: ParserKind[] = ["espree", "typescript-eslint"];
const componentConfigs: Array<{ label: string; ruleConfig: Linter.RuleEntry }> = [
    { label: "default option", ruleConfig: "error" },
    { label: "explicit component option", ruleConfig: ["error", OPTION_COMPONENT] },
];

function quoteAttribute(payload: string, quote: '"' | "'"): string {
    if (payload.includes(quote)) {
        throw new Error(`payload contains the ${quote} quote used to wrap it`);
    }
    return `${quote}${payload}${quote}`;
}

function sourceWithIcon(payload: string, quote: '"' | "'"): string {
    return `<Button icon=${quoteAttribute(payload, quote)} />`;
}

function languageOptions(parser: ParserKind): Linter.LanguageOptions {
    const parserOptions: Linter.ParserOptions = {
        ecmaFeatures: { jsx: true },
        ecmaVersion: "latest",
        sourceType: "module",
    };
    if (parser === "typescript-eslint") {
        return { ecmaVersion: "latest", parser: typescriptEslintParser, parserOptions, sourceType: "module" };
    }
    return { ecmaVersion: "latest", parserOptions, sourceType: "module" };
}

async function autofix(code: string, parser: ParserKind, ruleConfig: Linter.RuleEntry): Promise<string> {
    const eslint = new ESLint({
        cwd: __dirname,
        fix: true,
        overrideConfig: [
            {
                files: ["**/*.{js,jsx,ts,tsx}"],
                languageOptions: languageOptions(parser),
                plugins: {
                    "@blueprintjs": {
                        rules: {
                            "icon-components": iconComponentsRule,
                        },
                    },
                },
                rules: {
                    "@blueprintjs/icon-components": ruleConfig,
                },
            },
        ],
        overrideConfigFile: true,
    });
    let results: ESLint.LintResult[];
    try {
        results = await eslint.lintText(code, { filePath: "Widget.tsx" });
    } catch (error) {
        throw new Error(`eslint --fix threw while fixing ${code}: ${error instanceof Error ? error.message : error}`);
    }
    const result = results[0];
    // A fix that produces source the next pass cannot parse still returns that source.
    // ESLint writes result.output when it is a string, including after a later fatal parse.
    if (result.output == null) {
        const fatal = result.messages.find(message => message.fatal);
        if (fatal != null) {
            throw new Error(`eslint --fix could not parse ${code}: ${fatal.message}`);
        }
    }
    return result.output ?? code;
}

function syntaxError(code: string): string | undefined {
    const sourceFile = ts.createSourceFile("Widget.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const diagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] })
        .parseDiagnostics;
    if (diagnostics == null || diagnostics.length === 0) {
        return undefined;
    }
    return diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n");
}

function iconAttributeShape(code: string): string {
    const sourceFile = ts.createSourceFile("Widget.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let shape = "missing";
    const visit = (node: ts.Node): void => {
        if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === "icon") {
            const initializer = node.initializer;
            if (initializer == null) {
                shape = "boolean";
            } else if (ts.isStringLiteral(initializer)) {
                shape = `string:${initializer.text}`;
            } else if (
                ts.isJsxExpression(initializer) &&
                initializer.expression != null &&
                ts.isJsxSelfClosingElement(initializer.expression) &&
                ts.isIdentifier(initializer.expression.tagName)
            ) {
                shape = `element:${initializer.expression.tagName.text}`;
            } else {
                shape = `other:${initializer.getText(sourceFile)}`;
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return shape;
}

/**
 * Transpile the fixed JSX with the TypeScript version this repo compiles with and run that
 * JavaScript. alert returns true so a later `|| <Tag />` is not evaluated.
 */
function alertCallsInRenderedJsx(code: string): number {
    const transpiled = ts.transpileModule(`const __element = (\n${code}\n);\n__element;\n`, {
        compilerOptions: {
            jsx: ts.JsxEmit.React,
            module: ts.ModuleKind.None,
            target: ts.ScriptTarget.ES2022,
        },
        fileName: "Widget.tsx",
        reportDiagnostics: true,
    });
    const diagnostics = transpiled.diagnostics ?? [];
    if (diagnostics.length > 0) {
        const message = diagnostics
            .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
            .join("\n");
        throw new Error(`TypeScript could not compile the autofix output:\n${code}\n${message}`);
    }
    let alertCalls = 0;
    const sandbox: Record<string, unknown> = {
        Button: () => null,
        ChevronRightIcon: () => null,
        DoubleCaretVerticalIcon: () => null,
        React: {
            createElement: (...args: unknown[]) => ({ args }),
        },
        TickIcon: () => null,
        alert: () => {
            alertCalls += 1;
            return true;
        },
        document: { domain: "example.test" },
        yIcon: () => null,
    };
    vm.runInNewContext(transpiled.outputText, sandbox, { timeout: 1000 });
    return alertCalls;
}

async function expectInertAutofix(code: string, parser: ParserKind, ruleConfig: Linter.RuleEntry): Promise<string> {
    const output = await autofix(code, parser, ruleConfig);
    const parsed = syntaxError(output);
    let calls = -1;
    let runtimeError: string | undefined;
    if (parsed == null) {
        try {
            calls = alertCallsInRenderedJsx(output);
        } catch (error) {
            runtimeError = error instanceof Error ? error.message : String(error);
        }
    }
    expect(
        { calls, output, parsed, runtimeError },
        `autofix of ${code} with ${parser} produced JavaScript that runs the icon string\n${output}`,
    ).toEqual({
        calls: 0,
        output: expect.any(String),
        parsed: undefined,
        runtimeError: undefined,
    });
    return output;
}

describe("icon-components autofix must not execute icon string contents", () => {
    it("still rewrites a well-formed icon name, so these tests are exercising the fixer", async () => {
        for (const parser of parsers) {
            for (const { ruleConfig } of componentConfigs) {
                const output = await autofix(`<Button icon="tick" />`, parser, ruleConfig);
                expect(output).toBe(`<Button icon={<TickIcon />} />`);
                const hyphenated = await autofix(`<Button icon="chevron-right" />`, parser, ruleConfig);
                expect(hyphenated).toBe(`<Button icon={<ChevronRightIcon />} />`);
                const quoted = await autofix(`<Button icon='double-caret-vertical' />`, parser, ruleConfig);
                expect(quoted).toBe(`<Button icon={<DoubleCaretVerticalIcon />} />`);
            }
        }
    });

    const injectionCases: FixCase[] = [];
    for (const parser of parsers) {
        for (const { label, ruleConfig } of componentConfigs) {
            for (const quote of ['"', "'"] as const) {
                injectionCases.push({
                    label: `${parser} / ${label} / ${quote === '"' ? "double" : "single"} quotes / breakout`,
                    parser,
                    payload: CALLED_PAYLOAD,
                    quote,
                    ruleConfig,
                });
                if (quote === '"') {
                    injectionCases.push(
                        {
                            label: `${parser} / ${label} / hyphen builds Function`,
                            parser,
                            payload: FUNCTION_PAYLOAD,
                            quote,
                            ruleConfig,
                        },
                        {
                            label: `${parser} / ${label} / hex escape builds alert`,
                            parser,
                            payload: HEX_PAYLOAD,
                            quote,
                            ruleConfig,
                        },
                        {
                            label: `${parser} / ${label} / entity-encoded breakout`,
                            parser,
                            payload: ENTITY_PAYLOAD,
                            quote,
                            ruleConfig,
                        },
                    );
                }
            }
        }
    }

    it.each(injectionCases)("$label", async ({ parser, payload, quote, ruleConfig }) => {
        await expectInertAutofix(sourceWithIcon(payload, quote), parser, ruleConfig);
    });

    it.each(parsers)("does not throw or invent a tag from an empty or broken name (%s)", async parser => {
        for (const payload of ["", "-", "-tick", "tick-", "a-"]) {
            await expectInertAutofix(sourceWithIcon(payload, '"'), parser, "error");
        }
    });

    it.each(parsers)(
        "builds a component only from the decoded icon name, not from raw entity text (%s)",
        async parser => {
            const output = await autofix(sourceWithIcon(ENTITY_NAME, '"'), parser, "error");
            expect(syntaxError(output), output).toBeUndefined();
            const shape = iconAttributeShape(output);
            expect(["string:t&#105;ck", "element:TickIcon"], output).toContain(shape);
            expect(alertCallsInRenderedJsx(output), output).toBe(0);
        },
    );

    it("literal mode replaces a component with a quoted name and drops surrounding expressions", async () => {
        const code = `<Button icon={<TickIcon /> && alert(document.domain)} />`;
        for (const parser of parsers) {
            const output = await autofix(code, parser, ["error", OPTION_LITERAL]);
            expect(output).toBe(`<Button icon="tick" />`);
            expect(alertCallsInRenderedJsx(output)).toBe(0);
        }
    });

    it("literal mode does not rewrite a string held inside an expression", async () => {
        const code = `<Button icon={"${CALLED_PAYLOAD}"} />`;
        for (const parser of parsers) {
            const output = await autofix(code, parser, "error");
            expect(output).toBe(code);
            expect(alertCallsInRenderedJsx(output)).toBe(0);
        }
    });
});

function tslintFix(code: string, ruleSetting: true | [true, "component"]): string {
    // The compiled rule has to live inside the package so Node can resolve tslint and typescript.
    const rulesDirectory = fs.mkdtempSync(path.resolve(__dirname, "../../tslint-config/test/.icon-rule-"));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "blueprint-icon-lint-"));
    try {
        const ruleSource = fs.readFileSync(
            path.resolve(__dirname, "../../tslint-config/src/rules/blueprintIconComponentsRule.ts"),
            "utf8",
        );
        const compiled = ts.transpileModule(ruleSource, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2015 },
            fileName: "blueprintIconComponentsRule.ts",
        });
        fs.writeFileSync(path.join(rulesDirectory, "blueprintIconComponentsRule.js"), compiled.outputText, "utf8");
        const filePath = path.join(directory, "Widget.tsx");
        const configPath = path.join(directory, "tslint.json");
        fs.writeFileSync(filePath, code, "utf8");
        fs.writeFileSync(
            configPath,
            JSON.stringify({
                rules: { "blueprint-icon-components": ruleSetting },
                rulesDirectory: [rulesDirectory],
            }),
            "utf8",
        );
        const linter = new tslint.Linter({ fix: true, rulesDirectory });
        linter.lint(filePath, code, tslint.Linter.loadConfigurationFromPath(configPath));
        linter.getResult();
        return fs.readFileSync(filePath, "utf8");
    } finally {
        fs.rmSync(directory, { force: true, recursive: true });
        fs.rmSync(rulesDirectory, { force: true, recursive: true });
    }
}

describe("tslint blueprint-icon-components autofix", () => {
    it("rewrites a well-formed icon name when the rule is enabled", () => {
        for (const setting of [true, [true, "component"]] as const) {
            expect(tslintFix(`<Button icon="tick" />`, setting)).toBe(`<Button icon={<TickIcon />} />`);
        }
    });

    it("does not leave executable JavaScript in the file tslint --fix writes", () => {
        for (const setting of [true, [true, "component"]] as const) {
            for (const payload of [CALLED_PAYLOAD, FUNCTION_PAYLOAD, HEX_PAYLOAD]) {
                const output = tslintFix(sourceWithIcon(payload, '"'), setting);
                const parsed = syntaxError(output);
                let calls = -1;
                let runtimeError: string | undefined;
                if (parsed == null) {
                    try {
                        calls = alertCallsInRenderedJsx(output);
                    } catch (error) {
                        runtimeError = error instanceof Error ? error.message : String(error);
                    }
                }
                expect({ calls, output, parsed, runtimeError }, output).toEqual({
                    calls: 0,
                    output: expect.any(String),
                    parsed: undefined,
                    runtimeError: undefined,
                });
            }
        }
    });
});
