/*
 * Copyright 2026 Palantir Technologies, Inc. All rights reserved.
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

// @ts-check

import { join } from "node:path";
import stylelint, { type LinterOptions, type LinterResult, type Warning } from "stylelint";
import { describe, expect, it } from "vitest";

/**
 * Nesting count for `:is(`. postcss-selector-parser 7.1.1 still parses this,
 * then overflows while walking or serializing the tree. 7.1.3 rejects it with
 * a bounded nesting-depth error.
 */
const OVERFLOW_NESTING_DEPTH = 1500;

const pluginConfig: LinterOptions["config"] = {
    customSyntax: "postcss-scss",
    plugins: ["@blueprintjs/stylelint-plugin"],
    rules: {
        "@blueprintjs/no-prefix-literal": true,
    },
};

function nestedIsRule(depth: number): string {
    return `${":is(".repeat(depth)}.bp5-button${")".repeat(depth)} {\n    color: red;\n}\n`;
}

interface LintOutcome {
    error?: unknown;
    result?: LinterResult;
}

async function lintContributedStylesheet(filename: string, code: string, options: LinterOptions): Promise<LintOutcome> {
    try {
        const result = await stylelint.lint({
            ...options,
            code,
            codeFilename: join(import.meta.dirname, filename),
        });
        return { result };
    } catch (error) {
        return { error };
    }
}

function messagesFrom(outcome: LintOutcome): string[] {
    const messages: string[] = [];
    if (outcome.error instanceof Error) {
        messages.push(outcome.error.message);
    }
    const lintResult = outcome.result?.results[0];
    const warnings = lintResult?.warnings ?? [];
    const parseErrors = (lintResult?.parseErrors ?? []) as Warning[];
    for (const warning of [...warnings, ...parseErrors]) {
        messages.push(warning.text);
    }
    return messages;
}

function assertBoundedNestingRejection(outcome: LintOutcome) {
    expect(outcome.error).not.toBeInstanceOf(RangeError);
    if (outcome.error instanceof Error) {
        expect(outcome.error.message).not.toContain("Maximum call stack size exceeded");
    }
    const messages = messagesFrom(outcome);
    expect(messages.join("\n")).toContain("nesting depth exceeds the maximum");
    expect(messages.join("\n")).not.toContain("Maximum call stack size exceeded");
}

describe("deeply nested selectors passed to postcss-selector-parser", () => {
    it("rejects a contributed scss selector without overflowing the stack", async () => {
        const outcome = await lintContributedStylesheet(
            "contributed-nested.scss",
            nestedIsRule(OVERFLOW_NESTING_DEPTH),
            {
                config: pluginConfig,
            },
        );
        assertBoundedNestingRejection(outcome);
    });

    it("rejects a contributed less selector without overflowing the stack", async () => {
        const outcome = await lintContributedStylesheet(
            "contributed-nested.less",
            nestedIsRule(OVERFLOW_NESTING_DEPTH),
            {
                config: {
                    plugins: ["@blueprintjs/stylelint-plugin"],
                    rules: {
                        "@blueprintjs/no-prefix-literal": true,
                    },
                },
            },
        );
        assertBoundedNestingRejection(outcome);
    });

    it("rejects a contributed scss selector in fix mode without overflowing the stack", async () => {
        const outcome = await lintContributedStylesheet(
            "contributed-nested-fix.scss",
            nestedIsRule(OVERFLOW_NESTING_DEPTH),
            {
                config: pluginConfig,
                fix: true,
            },
        );
        assertBoundedNestingRejection(outcome);
    });

    it("rejects a contributed selector under selector-max-universal without overflowing the stack", async () => {
        const outcome = await lintContributedStylesheet(
            "contributed-nested.css",
            nestedIsRule(OVERFLOW_NESTING_DEPTH),
            {
                config: {
                    rules: {
                        "selector-max-universal": 1,
                    },
                },
            },
        );
        assertBoundedNestingRejection(outcome);
    });

    it("still lints a shallow nested prefix selector", async () => {
        const outcome = await lintContributedStylesheet("contributed-shallow.scss", nestedIsRule(3), {
            config: pluginConfig,
        });
        expect(outcome.error).toBeUndefined();
        const warnings = outcome.result?.results[0].warnings ?? [];
        expect(warnings.map(warning => warning.text).join("\n")).toContain("@blueprintjs/no-prefix-literal");
    });
});
