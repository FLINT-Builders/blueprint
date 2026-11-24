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

import { AST_NODE_TYPES, type TSESLint, type TSESTree } from "@typescript-eslint/utils";

import { addImportToFile } from "./utils/addImportToFile";
import { createRule } from "./utils/createRule";
import { FixList } from "./utils/fixList";
import { getProgram } from "./utils/getProgram";

// find all pt- prefixed classes, except those that begin with pt-icon (handled by other rules).
// currently supports "pt-", "bp3-", "bp4-", "bp5-", "bp6-" prefixes.
const BLUEPRINT_CLASSNAME_PATTERN = /(?<![\w])((?:pt|bp3|bp4|bp5|bp6)-(?!icon)[\w-]+)/g;

type MessageIds = "useBlueprintClasses";

/* eslint-disable sort-keys */
export const classesConstantsRule = createRule<[], MessageIds>({
    name: "classes-constants",
    meta: {
        docs: {
            description: "Enforce usage of Classes constants over namespaced string literals.",
            recommended: true,
            requiresTypeChecking: false,
        },
        fixable: "code",
        messages: {
            useBlueprintClasses: "use Blueprint `Classes` constant instead of string literal",
        },
        schema: [],
        type: "suggestion",
    },
    defaultOptions: [],
    create: context => ({
        "Literal, TemplateElement": node => create(context, node),
    }),
});

function create(
    context: TSESLint.RuleContext<MessageIds, []>,
    node: TSESTree.Literal | TSESTree.TemplateElement,
): void {
    // We shouldn't lint on strings from imports/exports
    if (
        node.parent?.type === AST_NODE_TYPES.ImportDeclaration ||
        node.parent?.type === AST_NODE_TYPES.ExportNamedDeclaration
    ) {
        return;
    }
    const nodeValue =
        node.type === AST_NODE_TYPES.TemplateElement
            ? node.value.raw
            : typeof node.value === "string"
              ? node.value
              : node.raw;
    const prefixMatches = getAllMatches(nodeValue);
    if (prefixMatches.length > 0) {
        let replacement: { node: TSESTree.Node; text: string } | undefined;
        if (node.type === AST_NODE_TYPES.TemplateElement) {
            replacement = getTemplateReplacement(context.sourceCode.getText(node), node, prefixMatches);
        } else if (typeof node.value === "string") {
            // "string literal" likely becomes `${template} string` so we may need to change how it is assigned
            replacement = { node, text: wrapForParent(getLiteralReplacement(node.value, prefixMatches), node) };
        }
        context.report({
            messageId: "useBlueprintClasses",
            node,
            fix: fixer => {
                if (replacement === undefined) {
                    return null;
                }
                const fixes = new FixList();

                fixes.addFixes(fixer.replaceText(replacement.node, replacement.text));

                // Add import for the Classes enum
                const program = getProgram(node);
                if (program !== undefined) {
                    fixes.addFixes(addImportToFile(program, ["Classes"], "@blueprintjs/core")(fixer));
                }

                return fixes.getFixes();
            },
        });
    }
}

function getAllMatches(className: string) {
    const ptMatches = [];
    let currentMatch: RegExpExecArray | null;

    while ((currentMatch = BLUEPRINT_CLASSNAME_PATTERN.exec(className)) != null) {
        ptMatches.push({ match: currentMatch[1], index: currentMatch.index || 0 });
    }
    return ptMatches;
}

/**
 * Produce replacement text for a string literal that contains invalid classes.
 * `value` is the literal's evaluated string, not its source text, so every segment copied into the
 * template must go through `escapeTemplateText` to keep it inert.
 */
function getLiteralReplacement(value: string, prefixMatches: Array<{ match: string; index: number }>) {
    // Special case: the string consists entirely of the invalid class name (ignoring spaces)
    // In this scenario, we just want to return the converted classnames without surrounding with ${} for interpolation
    if (prefixMatches.length === 1) {
        const remainingString = value.replace(prefixMatches[0].match, "").replace(/(\s)+/, "$1").trim();
        if (remainingString.length === 0) {
            return convertPtClassName(prefixMatches[0].match);
        }
    }

    // Start with the beginning of the string until the first match of an invalid classname
    let newString = "";
    let currentIndex = 0;
    for (const { match, index } of prefixMatches) {
        // Add the strings between the currentIndex and this invalid class name's index
        newString += escapeTemplateText(value.slice(currentIndex, index));
        // Add the converted string instead of the original string
        newString += `\${${convertPtClassName(match)}}`;
        // Update the index to immediately after this invalid class name
        currentIndex = index + match.length;
    }
    // Add remaining parts of string that occurred after the last invalid class name
    newString += escapeTemplateText(value.slice(currentIndex));
    // Merge & trim any remaining white space
    newString = newString.replace(/(\s)+/, "$1").trim();
    // Surround with backticks instead for the newly added template strings
    return `\`${newString}\``;
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

/**
 * Produce the replacement for a `template string` element that contains invalid classes.
 * `sourceText` is the element's own source, including its `` ` ``, `}` or `${` delimiters. Only the
 * class names are swapped for substitutions; everything else is kept verbatim so existing escapes
 * and delimiters keep their meaning.
 */
function getTemplateReplacement(
    sourceText: string,
    node: TSESTree.TemplateElement,
    prefixMatches: Array<{ match: string; index: number }>,
): { node: TSESTree.Node; text: string } | undefined {
    const template = node.parent;
    if (template?.type !== AST_NODE_TYPES.TemplateLiteral) {
        return undefined;
    }

    // if the class is the only contents of an untagged template, we can remove the template
    if (
        template.quasis.length === 1 &&
        template.parent?.type !== AST_NODE_TYPES.TaggedTemplateExpression &&
        prefixMatches.length === 1 &&
        node.value.raw === prefixMatches[0].match
    ) {
        return { node: template, text: convertPtClassName(prefixMatches[0].match) };
    }

    let newText = "";
    let currentIndex = 0;
    for (const { match, index } of getAllMatches(sourceText)) {
        // a class name right after an unescaped backslash is part of an escape sequence; leave it alone
        if (countPrecedingBackslashes(sourceText, index) % 2 === 1) {
            continue;
        }
        newText += sourceText.slice(currentIndex, index);
        newText += `\${${convertPtClassName(match)}}`;
        currentIndex = index + match.length;
    }
    if (currentIndex === 0) {
        return undefined;
    }
    newText += sourceText.slice(currentIndex);
    return { node, text: newText };
}

function countPrecedingBackslashes(text: string, index: number) {
    let count = 0;
    while (index - count > 0 && text[index - count - 1] === "\\") {
        count++;
    }
    return count;
}

/** Wrap the given statement based on the type of the parent node: JSX props, expressions, etc. */
function wrapForParent(statement: string, node: TSESTree.Node) {
    const { parent } = node;
    if (parent === undefined) {
        return statement;
    } else if (parent.type === AST_NODE_TYPES.JSXAttribute) {
        return `{${statement}}`;
    } else if (parent.type === AST_NODE_TYPES.ExpressionStatement) {
        return `[${statement}]`;
    } else {
        return statement;
    }
}

/** Converts a `pt-class-name` literal to `Classes.CLASS_NAME` constant. */
function convertPtClassName(text: string) {
    const className = text
        .replace(/(pt|bp3|bp4|bp5|bp6)-/, "")
        .replace(/-/g, "_")
        .toUpperCase();
    return `Classes.${className}`;
}
