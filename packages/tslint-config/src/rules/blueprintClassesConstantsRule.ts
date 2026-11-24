/*
 * Copyright 2018 Palantir Technologies, Inc. All rights reserved.
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

import * as Lint from "tslint";
import { isExpressionStatement, isJsxAttribute, isPropertyAssignment, isStringLiteral } from "tsutils/typeguard/2.8";
import * as ts from "typescript";

import { addImportToFile } from "./utils/addImportToFile";

// find all pt- prefixed classes, except those that begin with pt-icon (handled by other rules).
// currently support pt- and bp3- prefixes.
const BLUEPRINT_CLASSNAME_PATTERN = /[^\w-<.]((pt|bp3)-(?!icon-?)[\w-]+)/g;

export class Rule extends Lint.Rules.AbstractRule {
    public static metadata: Lint.IRuleMetadata = {
        ruleName: "blueprint-classes-constants",
        /* eslint-disable-next-line sort-keys */
        description: "Enforce usage of Classes constants over namespaced string literals.",
        optionExamples: ["true"],
        options: null,
        optionsDescription: "Not configurable",
        type: "style",
        typescriptOnly: false,
    };

    public static FAILURE_STRING = "use Blueprint `Classes` constant instead of string literal";

    public apply(sourceFile: ts.SourceFile): Lint.RuleFailure[] {
        return this.applyWithFunction(sourceFile, walk);
    }
}

function walk(ctx: Lint.WalkContext<void>) {
    let shouldFixImports = true;
    return ts.forEachChild(ctx.sourceFile, callback);

    function callback(node: ts.Node): void {
        if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
            const prefixMatches = getAllMatches(node.getFullText());
            if (prefixMatches.length > 0) {
                const ptClassStrings = prefixMatches.map(m => m.match);
                const replacementText = isStringLiteral(node)
                    ? // "string literal" likely becomes `${template} string` so we may need to change how it is assigned
                      wrapForParent(getLiteralReplacement(node.text, ptClassStrings), node)
                    : getTemplateReplacement(node.getText(), ptClassStrings);

                const replacements = [new Lint.Replacement(node.getStart(), node.getWidth(), replacementText)];
                if (shouldFixImports) {
                    // add an import statement for `Classes` constants at most once.
                    replacements.unshift(addImportToFile(ctx.sourceFile, ["Classes"], "@blueprintjs/core"));
                    shouldFixImports = false;
                }

                ctx.addFailureAt(
                    node.getFullStart() + prefixMatches[0].index + 1,
                    prefixMatches[0].match.length,
                    Rule.FAILURE_STRING,
                    replacements,
                );
            }
        }

        return ts.forEachChild(node, callback);
    }
}

/** Returns array of all invalid string matches detected in the given className string. */
function getAllMatches(className: string) {
    const ptMatches = [];
    let currentMatch: RegExpMatchArray | null;
    while ((currentMatch = BLUEPRINT_CLASSNAME_PATTERN.exec(className)) != null) {
        ptMatches.push({ index: currentMatch.index || 0, match: currentMatch[1] });
    }
    return ptMatches;
}

/**
 * Produce replacement text for a string literal that contains invalid classes.
 * `value` is the literal's text without quotes, so it must go through `escapeTemplateText` before
 * it is placed in a template.
 */
function getLiteralReplacement(value: string, ptClassStrings: string[]) {
    // remove all illegal classnames, then merge & trim any remaining white space
    const stringWithoutPtClasses = ptClassStrings
        .reduce((text, cssClass) => text.replace(cssClass, ""), value)
        .replace(/(\s)+/, "$1")
        .trim();
    // special case: only one invalid class name
    if (stringWithoutPtClasses.length === 0 && ptClassStrings.length === 1) {
        return convertPtClassName(ptClassStrings[0]);
    }
    // otherwise produce a `template string`
    const templateStrings = ptClassStrings.map(n => `\${${convertPtClassName(n)}}`).join(" ");
    return `\`${[templateStrings, escapeTemplateText(stringWithoutPtClasses)].join(" ").trim()}\``;
}

const TEMPLATE_ESCAPES: Record<string, string> = {
    "\b": "\\b",
    "\t": "\\t",
    "\n": "\\n",
    "\v": "\\v",
    "\f": "\\f",
    "\r": "\\r",
    $: "\\$",
    "\\": "\\\\",
    "`": "\\`",
};

/** Escape a string so that, placed between backticks, it evaluates to exactly the same string. */
function escapeTemplateText(text: string) {
    let escaped = "";
    for (const char of text) {
        const codePoint = char.codePointAt(0)!;
        if (TEMPLATE_ESCAPES[char] !== undefined) {
            escaped += TEMPLATE_ESCAPES[char];
        } else if (
            codePoint < 0x20 ||
            codePoint === 0x7f ||
            codePoint === 0x2028 ||
            codePoint === 0x2029 ||
            (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
            escaped += `\\u${codePoint.toString(16).padStart(4, "0")}`;
        } else {
            escaped += char;
        }
    }
    return escaped;
}

/** Produce replacement text for a `template string` that contains invalid classes. */
function getTemplateReplacement(className: string, ptClassStrings: string[]) {
    return ptClassStrings.reduce(
        (value, cssClass) => value.replace(cssClass, `\${${convertPtClassName(cssClass)}}`),
        className,
    );
}

/** Wrap the given statement based on the type of the parent node: JSX props, expressions, etc. */
function wrapForParent(statement: string, node: ts.Node) {
    const { parent } = node;
    if (parent === undefined) {
        return statement;
    } else if (isJsxAttribute(parent)) {
        return `{${statement}}`;
    } else if (isExpressionStatement(parent)) {
        return `[${statement}]`;
        // If we're changing the key, it will be child index 0 and we need to wrap it.
        // Else, we're changing a value, and there's no need to wrap
    } else if (isPropertyAssignment(parent) && parent.getChildAt(0) === node) {
        return `[${statement}]`;
    } else {
        return statement;
    }
}

/** Converts a `pt-class-name` literal to `Classes.CLASS_NAME` constant. */
function convertPtClassName(text: string) {
    const className = text
        .replace(/(pt|bp3)-/, "")
        .replace(/-/g, "_")
        .toUpperCase();
    return `Classes.${className}`;
}
