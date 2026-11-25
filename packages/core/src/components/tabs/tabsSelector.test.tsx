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

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Component, type ReactNode } from "react";

import { afterEach, beforeEach, describe, expect, it } from "@blueprintjs/test-commons/vitest";

import { Classes } from "../../common";

import { Tab } from "./tab";
import { Tabs } from "./tabs";

/**
 * Selected tab ids are interpolated into a double-quoted attribute selector.
 * These cases are strings the selector parser rejects or misreads until that
 * id is escaped. Each test expects the surrounding tree to stay mounted and
 * the selection indicator to track the tab with that id.
 */
const SELECTOR_TAB_IDS = [
    { id: 'foo"bar', label: "double quote" },
    { id: "foo\\", label: "trailing backslash" },
    { id: "a\\b", label: "embedded backslash" },
    { id: "foo\nbar", label: "newline" },
    { id: "foo\rbar", label: "carriage return" },
    { id: "foo\fbar", label: "form feed" },
] as const;

class TreeBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
    public state = { failed: false };

    public static getDerivedStateFromError() {
        return { failed: true };
    }

    public render() {
        if (this.state.failed) {
            return <div>tree failed</div>;
        }
        return this.props.children;
    }
}

function tabById(id: string) {
    return Array.from(document.querySelectorAll<HTMLElement>("[role='tab']")).find(
        tab => tab.getAttribute("data-tab-id") === id,
    );
}

function expectTreeIntact(id: string) {
    expect(screen.queryByText("tree failed")).not.toBeInTheDocument();
    expect(screen.getByTestId("neighbor")).toBeInTheDocument();
    expect(tabById(id)).toBeTruthy();
}

async function expectIndicatorOn(id: string) {
    await waitFor(() => {
        expectTreeIntact(id);
        const tab = tabById(id);
        const indicator = document.querySelector<HTMLElement>(`.${Classes.TAB_INDICATOR_WRAPPER}`);
        expect(indicator).not.toBeNull();
        expect(indicator!.style.display).not.toBe("none");
        expect(indicator!.style.transform).toContain(`translateX(${tab!.offsetLeft}px)`);
    });
}

function installDistinctOffsets() {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetLeft");
    Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
        configurable: true,
        get() {
            const id = this.getAttribute?.("data-tab-id");
            if (typeof id !== "string") {
                return 0;
            }
            let hash = 0;
            for (let index = 0; index < id.length; index++) {
                hash = (hash + id.charCodeAt(index) * (index + 1)) % 5000;
            }
            return 100 + hash;
        },
    });
    return () => {
        if (descriptor != null) {
            Object.defineProperty(HTMLElement.prototype, "offsetLeft", descriptor);
        }
    };
}

describe("Tabs selected id selector", () => {
    let restoreOffsets: (() => void) | undefined;

    beforeEach(() => {
        restoreOffsets = installDistinctOffsets();
    });

    afterEach(() => {
        restoreOffsets?.();
    });

    describe("on mount", () => {
        it.each(SELECTOR_TAB_IDS)("keeps the tree mounted for a $label id", async ({ id }) => {
            render(
                <TreeBoundary>
                    <div data-testid="neighbor">neighbor</div>
                    <Tabs id="tabs-selector">
                        <Tab id={id} title="Chosen" panel={<span>Chosen panel</span>} />
                        <Tab id="other" title="Other" panel={<span>Other panel</span>} />
                    </Tabs>
                </TreeBoundary>,
            );

            await expectIndicatorOn(id);
            expect(screen.getByText("Chosen panel")).toBeInTheDocument();
        });

        it("keeps the tree mounted when the controlled id matches no tab", async () => {
            const id = 'missing"id';
            render(
                <TreeBoundary>
                    <div data-testid="neighbor">neighbor</div>
                    <Tabs id="tabs-selector" selectedTabId={id}>
                        <Tab id="other" title="Other" panel={<span>Other panel</span>} />
                    </Tabs>
                </TreeBoundary>,
            );

            await waitFor(() => {
                expectTreeIntact("other");
                const indicator = document.querySelector<HTMLElement>(`.${Classes.TAB_INDICATOR_WRAPPER}`);
                expect(indicator).not.toBeNull();
                expect(indicator!.style.display).toBe("none");
            });
        });
    });

    describe("when the selected id changes", () => {
        it.each(SELECTOR_TAB_IDS)("keeps the tree mounted after selecting a $label id", async ({ id }) => {
            const { rerender } = render(
                <TreeBoundary>
                    <div data-testid="neighbor">neighbor</div>
                    <Tabs id="tabs-selector" selectedTabId="other">
                        <Tab id={id} title="Chosen" panel={<span>Chosen panel</span>} />
                        <Tab id="other" title="Other" panel={<span>Other panel</span>} />
                    </Tabs>
                </TreeBoundary>,
            );

            await expectIndicatorOn("other");

            rerender(
                <TreeBoundary>
                    <div data-testid="neighbor">neighbor</div>
                    <Tabs id="tabs-selector" selectedTabId={id}>
                        <Tab id={id} title="Chosen" panel={<span>Chosen panel</span>} />
                        <Tab id="other" title="Other" panel={<span>Other panel</span>} />
                    </Tabs>
                </TreeBoundary>,
            );

            await expectIndicatorOn(id);
        });

        it("keeps the tree mounted after an uncontrolled click on a quoted id", async () => {
            const id = 'clicked"tab';
            const user = userEvent.setup();
            render(
                <TreeBoundary>
                    <div data-testid="neighbor">neighbor</div>
                    <Tabs id="tabs-selector">
                        <Tab id="other" title="Other" panel={<span>Other panel</span>} />
                        <Tab id={id} title="Chosen" panel={<span>Chosen panel</span>} />
                    </Tabs>
                </TreeBoundary>,
            );

            await expectIndicatorOn("other");
            await user.click(screen.getByRole("tab", { name: "Chosen" }));
            await expectIndicatorOn(id);
        });
    });

    describe("when tab children change", () => {
        it.each(SELECTOR_TAB_IDS)("keeps the tree mounted when children change under a $label id", async ({ id }) => {
            const { rerender } = render(
                <TreeBoundary>
                    <div data-testid="neighbor">neighbor</div>
                    <Tabs animate={false} id="tabs-selector" selectedTabId={id}>
                        <Tab id={id} title="Chosen" panel={<span>Chosen panel</span>} />
                        <Tab id="other" title="Other" panel={<span>Other panel</span>} />
                    </Tabs>
                </TreeBoundary>,
            );

            expectTreeIntact(id);

            rerender(
                <TreeBoundary>
                    <div data-testid="neighbor">neighbor</div>
                    <Tabs animate={true} id="tabs-selector" selectedTabId={id}>
                        <Tab id={id} title="Chosen renamed" panel={<span>Chosen panel</span>} />
                        <Tab id="other" title="Other" panel={<span>Other panel</span>} />
                    </Tabs>
                </TreeBoundary>,
            );

            await expectIndicatorOn(id);
        });
    });
});
