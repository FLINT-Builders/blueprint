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
 * Spec for the classes-constants autofix.
 *
 * A string or regex literal that contains a Blueprint class is inert text. The recommended
 * config's autofix must not turn `${...}` or backticks inside that text into code that runs
 * when the fixed module is evaluated. Escaping copied segments, building them with
 * concatenation, or reporting the literal without applying a fix all satisfy these tests.
 * These tests fail while the unescaped rewrite is still in place.
 */

/* eslint-disable no-template-curly-in-string -- fixtures intentionally contain placeholder text */

import { Linter } from "eslint";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import plugin from "../src/index";

const require = createRequire(import.meta.url);
// Same espree ESLint 9.38.0 loads (espree 10.4.0). Used only to locate statement and JSX
// ranges so the fixed source can be evaluated. Expression text is copied by range, not rebuilt.
const espree = require(
    require.resolve("espree", {
        paths: [require("node:path").dirname(require.resolve("eslint/package.json"))],
    }),
) as {
    parse: (code: string, options: object) => EstreeNode;
};

interface EstreeNode {
    type: string;
    range: [number, number];
    name?: string;
    expression?: EstreeNode;
    argument?: EstreeNode;
    openingElement?: EstreeNode;
    children?: EstreeNode[];
    attributes?: EstreeNode[];
    body?: EstreeNode[];
    [key: string]: unknown;
}

interface SentinelHit {
    name: string;
    args: unknown[];
}

const linter = new Linter({ configType: "flat" });

const config = [
    {
        files: ["**/*"],
        ...plugin.flatConfigs.recommended,
        languageOptions: {
            parserOptions: {
                ecmaFeatures: { jsx: true },
                ecmaVersion: "latest",
            },
        },
    },
];

const PARSE_OPTIONS = {
    ecmaFeatures: { jsx: true },
    ecmaVersion: "latest",
    range: true,
    sourceType: "module",
};

function walk(node: EstreeNode, visit: (node: EstreeNode) => void): void {
    visit(node);
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
            for (const child of value) {
                if (isNode(child)) {
                    walk(child, visit);
                }
            }
        } else if (isNode(value)) {
            walk(value, visit);
        }
    }
}

function isNode(value: unknown): value is EstreeNode {
    return (
        typeof value === "object" &&
        value != null &&
        typeof (value as EstreeNode).type === "string" &&
        Array.isArray((value as EstreeNode).range)
    );
}

function containsJsx(node: EstreeNode): boolean {
    let found = false;
    walk(node, current => {
        if (current.type === "JSXElement" || current.type === "JSXFragment") {
            found = true;
        }
    });
    return found;
}

function outermostJsx(node: EstreeNode): EstreeNode[] {
    const found: EstreeNode[] = [];
    walk(node, current => {
        if (current !== node && (current.type === "JSXElement" || current.type === "JSXFragment")) {
            found.push(current);
        }
    });
    return found.filter(
        candidate =>
            !found.some(
                other =>
                    other !== candidate &&
                    other.range[0] <= candidate.range[0] &&
                    other.range[1] >= candidate.range[1] &&
                    (other.range[0] < candidate.range[0] || other.range[1] > candidate.range[1]),
            ),
    );
}

/** Copy a statement's source, replacing JSX elements with calls that keep attribute expressions verbatim. */
function emitStatement(node: EstreeNode, source: string): string {
    if (node.type === "JSXElement" || node.type === "JSXFragment") {
        return emitJsx(node, source);
    }
    if (!containsJsx(node)) {
        return source.slice(node.range[0], node.range[1]);
    }
    const start = node.range[0];
    let result = source.slice(start, node.range[1]);
    const replacements = outermostJsx(node).sort((left, right) => right.range[0] - left.range[0]);
    for (const jsx of replacements) {
        const from = jsx.range[0] - start;
        const to = jsx.range[1] - start;
        result = result.slice(0, from) + emitJsx(jsx, source) + result.slice(to);
    }
    return result;
}

function emitJsx(node: EstreeNode, source: string): string {
    if (node.type === "JSXFragment") {
        const fragmentChildren = (node.children ?? []).map(child => emitJsxChild(child, source));
        return `jsx(null, null${fragmentChildren.length > 0 ? `, ${fragmentChildren.join(", ")}` : ""})`;
    }
    const opening = node.openingElement;
    if (opening == null) {
        return "null";
    }
    const tag = jsxTagName(opening.name as EstreeNode, source);
    const props = (opening.attributes ?? []).map(attribute => emitAttribute(attribute, source));
    const children = (node.children ?? []).map(child => emitJsxChild(child, source));
    const childList = children.length > 0 ? `, ${children.join(", ")}` : "";
    return `jsx(${tag}, { ${props.join(", ")} }${childList})`;
}

function jsxTagName(name: EstreeNode | undefined, source: string): string {
    if (name == null) {
        return "null";
    }
    if (name.type === "JSXIdentifier" && typeof name.name === "string") {
        return JSON.stringify(name.name);
    }
    return JSON.stringify(source.slice(name.range[0], name.range[1]));
}

function emitAttribute(attribute: EstreeNode, source: string): string {
    if (attribute.type === "JSXSpreadAttribute" && attribute.argument != null) {
        return `...(${emitStatement(attribute.argument, source)})`;
    }
    const key = typeof attribute.name === "object" && attribute.name != null ? (attribute.name as EstreeNode).name : "";
    const value = attribute.value as EstreeNode | null | undefined;
    if (value == null) {
        return `${JSON.stringify(key)}: true`;
    }
    if (value.type === "Literal") {
        return `${JSON.stringify(key)}: (${source.slice(value.range[0], value.range[1])})`;
    }
    if (value.type === "JSXExpressionContainer") {
        if (value.expression == null || value.expression.type === "JSXEmptyExpression") {
            return `${JSON.stringify(key)}: undefined`;
        }
        return `${JSON.stringify(key)}: (${emitStatement(value.expression, source)})`;
    }
    return `${JSON.stringify(key)}: (${source.slice(value.range[0], value.range[1])})`;
}

function emitJsxChild(child: EstreeNode, source: string): string {
    if (child.type === "JSXText") {
        return JSON.stringify(source.slice(child.range[0], child.range[1]));
    }
    if (child.type === "JSXElement" || child.type === "JSXFragment") {
        return emitJsx(child, source);
    }
    if (child.type === "JSXExpressionContainer") {
        if (child.expression == null || child.expression.type === "JSXEmptyExpression") {
            return "null";
        }
        return `(${emitStatement(child.expression, source)})`;
    }
    return source.slice(child.range[0], child.range[1]);
}

/**
 * Evaluate module body the autofix produced. Import declarations are skipped and JSX is
 * lowered only by slicing original expression text into a `jsx()` call. `${...}` inside a
 * rewritten template therefore runs here exactly when it would run at module evaluation.
 */
function evaluate(source: string): SentinelHit[] {
    let program: EstreeNode;
    try {
        program = espree.parse(source, PARSE_OPTIONS);
    } catch (error) {
        throw new Error(`Autofix produced code that does not parse:\n${source}\n${String(error)}`);
    }
    const statements = (program.body ?? [])
        .filter(statement => statement.type !== "ImportDeclaration")
        .map(statement => emitStatement(statement, source));
    const hits: SentinelHit[] = [];
    const script = [
        "const Classes = new Proxy(Object.create(null), { get: () => 'class-value' });",
        "const jsx = () => null;",
        ...statements,
    ].join("\n");
    try {
        runInNewContext(
            script,
            {
                // Present only so a call-argument fixture can be evaluated. Arguments are evaluated
                // before the call, which is where an injected placeholder would run.
                classNames: () => undefined,
                nested: (...args: unknown[]) => {
                    hits.push({ args, name: "nested" });
                    return "nested-return";
                },
                payload: (...args: unknown[]) => {
                    hits.push({ args, name: "payload" });
                    return "payload-return";
                },
            },
            { timeout: 1000 },
        );
    } catch (error) {
        throw new Error(`Autofix produced code that failed during evaluation:\n${source}\n${String(error)}`);
    }
    return hits;
}

function fixedSource(code: string): string {
    return linter.verifyAndFix(code, config, { filename: "file.js" }).output;
}

function expectRuleReports(code: string): void {
    const messages = linter.verify(code, config, { filename: "file.js" });
    expect(messages.some(message => message.ruleId === "@blueprintjs/classes-constants")).toBe(true);
}

function expectAutofixStaysInert(code: string): void {
    expectRuleReports(code);
    expect(evaluate(code)).toEqual([]);
    const output = fixedSource(code);
    expect(evaluate(output)).toEqual([]);
}

describe("classes-constants autofix does not execute literal text", () => {
    it.each([
        ["double-quoted initializer", 'const className = "bp6-callout ${payload()}";'],
        ["single-quoted initializer", "const className = 'bp6-callout ${payload()}';"],
        ["placeholder before the class", 'const className = "${payload()} bp6-callout";'],
        ["placeholder with interior whitespace", 'const className = "bp6-callout ${ payload() }";'],
        ["two placeholders", 'const className = "bp6-callout ${payload(1)} ${payload(2)}";'],
        ["placeholder that is a tagged template", 'const className = "bp6-callout ${payload`${nested()}`}";'],
        [
            "class name nested inside the placeholder text",
            "const className = \"bp6-button ${payload('bp6-callout')}\";",
        ],
        ["even number of backslashes before the placeholder", 'const className = "bp6-callout \\\\${payload()}";'],
        ["pt- prefix", 'const className = "pt-button ${payload()}";'],
        ["bp3- prefix", 'const className = "bp3-button ${payload()}";'],
        ["bp4- prefix", 'const className = "bp4-button ${payload()}";'],
        ["bp5- prefix", 'const className = "bp5-button ${payload()}";'],
        ["call argument", 'classNames("bp6-callout ${payload()}");'],
        ["object property", 'const styles = { className: "bp6-callout ${payload()}" };'],
        ["expression statement", '"bp6-callout ${payload()}";'],
        ["several classes around the placeholder", 'const className = "bp6-button ${payload()} bp5-card";'],
        ["regex literal", "const pattern = /bp6-callout${payload()}x/;"],
    ])("keeps a %s inert", (_name, code) => {
        expectAutofixStaysInert(code);
    });

    it("keeps a JSX attribute string inert", () => {
        expectAutofixStaysInert('const element = <div className="bp6-callout ${payload()}" />;');
    });

    it("keeps a JSX expression-container string inert", () => {
        expectAutofixStaysInert('const element = <div className={"bp6-callout ${payload()}"} />;');
    });

    it("does not let a backtick inside a string close the inserted template and run a statement", () => {
        expectAutofixStaysInert('const className = "bp6-callout`;payload();`";');
    });

    it("does not let a backtick inside a JSX attribute string close the inserted template", () => {
        expectAutofixStaysInert('const element = <div className="bp6-callout`;payload();`" />;');
    });

    it("leaves an escaped placeholder in an existing template element inert", () => {
        const code = "const className = `bp6-callout \\${payload()}`;";
        expectAutofixStaysInert(code);
    });

    it("does not treat a unicode-escaped dollar sign in a string as a template placeholder", () => {
        expectAutofixStaysInert('const className = "bp6-callout \\u0024{payload()}";');
    });

    it("does not execute a placeholder that is already escaped by an odd number of backslashes", () => {
        expectAutofixStaysInert('const className = "bp6-callout \\\\\\${payload()}";');
    });

    it("still rewrites a benign class string to the Classes constant", () => {
        const code = 'const className = "bp6-callout extra";';
        expectRuleReports(code);
        const output = fixedSource(code);
        expect(output).toContain("Classes.CALLOUT");
        expect(output).not.toContain("bp6-callout");
        expect(evaluate(output)).toEqual([]);
    });
});
