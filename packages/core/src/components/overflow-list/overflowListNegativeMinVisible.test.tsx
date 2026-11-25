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

import { render, screen } from "@testing-library/react";
import { Profiler, type ProfilerOnRenderCallback } from "react";

import { afterEach, describe, expect, it, vi } from "@blueprintjs/test-commons/vitest";

import { Boundary, Classes } from "../../common";

import { OverflowList, type OverflowListProps } from "./overflowList";

/**
 * Spec for the unbounded repartition that starts when `minVisibleItems` is below zero while the
 * overflow spacer is narrower than one pixel. Rendering must settle at the same partition as a
 * zero minimum. These tests fail until that loop stops.
 */

interface Item {
    id: string;
}

const ITEMS: Item[] = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

/**
 * Halving the chop size over four items finishes in a handful of commits. A limit below React's
 * nested-update cap makes the failure the repartition loop itself.
 */
const MAX_COMMITS = 20;

type MinVisible = OverflowListProps<Item>["minVisibleItems"];

function renderVisibleItem(item: Item) {
    return <span key={item.id}>{item.id}</span>;
}

function renderOverflow(items: readonly Item[]) {
    return <span data-testid="overflow">{items.length}</span>;
}

function spacerWidth(): number {
    const spacer = document.querySelector(`.${Classes.OVERFLOW_LIST_SPACER}`);
    expect(spacer).toBeInstanceOf(HTMLElement);
    return (spacer as HTMLElement).offsetWidth;
}

function expectAllOverflowed() {
    expect(screen.getByTestId("overflow")).toHaveTextContent(String(ITEMS.length));
    for (const item of ITEMS) {
        expect(screen.queryByText(item.id)).not.toBeInTheDocument();
    }
}

function expectAllVisible() {
    for (const item of ITEMS) {
        expect(screen.getByText(item.id)).toBeInTheDocument();
    }
    expect(screen.queryByTestId("overflow")).not.toBeInTheDocument();
}

function mountOverflowList(minVisibleItems: MinVisible, extraProps: Partial<OverflowListProps<Item>> = {}) {
    let commits = 0;
    const onRender: ProfilerOnRenderCallback = () => {
        commits += 1;
        if (commits > MAX_COMMITS) {
            throw new Error(`OverflowList did not settle after ${MAX_COMMITS} commits`);
        }
    };
    const elementFor = (minimum: MinVisible, props: Partial<OverflowListProps<Item>> = extraProps) => (
        <Profiler id="overflow-list" onRender={onRender}>
            <OverflowList
                items={ITEMS}
                overflowRenderer={renderOverflow}
                visibleItemRenderer={renderVisibleItem}
                {...props}
                minVisibleItems={minimum}
            />
        </Profiler>
    );
    const view = render(elementFor(minVisibleItems));
    return {
        commitCount: () => commits,
        markCommits() {
            const at = commits;
            return () => commits - at;
        },
        rerenderWith(minimum: MinVisible, props?: Partial<OverflowListProps<Item>>) {
            view.rerender(elementFor(minimum, props ?? extraProps));
        },
    };
}

describe("OverflowList negative minVisibleItems", () => {
    const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");

    afterEach(() => {
        if (originalOffsetWidth != null) {
            Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalOffsetWidth);
        }
        vi.unstubAllGlobals();
    });

    it("collapses every item when the minimum is zero and the spacer is under one pixel", () => {
        const mounted = mountOverflowList(0);

        // jsdom reports no layout, so the spacer stays at 0, which is the narrow-container branch.
        expect(spacerWidth()).toBeLessThan(0.9);
        expect(mounted.commitCount()).toBeLessThanOrEqual(MAX_COMMITS);
        expectAllOverflowed();
    });

    it.each([-1, -0.5, -100, Number.NEGATIVE_INFINITY])(
        "settles at that same partition when minVisibleItems is %s",
        minVisibleItems => {
            const mounted = mountOverflowList(minVisibleItems);

            expect(spacerWidth()).toBeLessThan(0.9);
            expect(mounted.commitCount()).toBeLessThanOrEqual(MAX_COMMITS);
            expectAllOverflowed();
        },
    );

    it("settles when a forwarded query value is still the string '-1'", () => {
        // Declared as a number. The shrink comparison uses `>` and coerces a numeric string.
        const mounted = mountOverflowList("-1" as unknown as number);

        expect(spacerWidth()).toBeLessThan(0.9);
        expect(mounted.commitCount()).toBeLessThanOrEqual(MAX_COMMITS);
        expectAllOverflowed();
    });

    it("settles when there are no items and the minimum is negative", () => {
        const mounted = mountOverflowList(-1, { items: [] });

        expect(spacerWidth()).toBeLessThan(0.9);
        expect(mounted.commitCount()).toBeLessThanOrEqual(MAX_COMMITS);
        expect(screen.queryByTestId("overflow")).not.toBeInTheDocument();
        expect(screen.queryByText("a")).not.toBeInTheDocument();
    });

    it.each([Boundary.START, Boundary.END])("settles when collapsing from %s", collapseFrom => {
        const mounted = mountOverflowList(-1, { collapseFrom });

        expect(mounted.commitCount()).toBeLessThanOrEqual(MAX_COMMITS);
        expectAllOverflowed();
    });

    it("settles when the overflow indicator is always rendered", () => {
        const mounted = mountOverflowList(-1, { alwaysRenderOverflow: true });

        expect(mounted.commitCount()).toBeLessThanOrEqual(MAX_COMMITS);
        expect(screen.getByTestId("overflow")).toHaveTextContent(String(ITEMS.length));
    });

    it("settles when parent observation is enabled", () => {
        const mounted = mountOverflowList(-1, { observeParents: true });

        expect(mounted.commitCount()).toBeLessThanOrEqual(MAX_COMMITS);
        expectAllOverflowed();
    });

    it("settles after the minimum changes from zero to a negative number", () => {
        const mounted = mountOverflowList(0);
        expectAllOverflowed();
        const addedCommits = mounted.markCommits();

        mounted.rerenderWith(-1);

        expect(addedCommits()).toBeLessThanOrEqual(MAX_COMMITS);
        expect(mounted.commitCount()).toBeLessThanOrEqual(MAX_COMMITS * 2);
        expectAllOverflowed();
    });

    it("settles after the items change while the minimum stays negative", () => {
        const mounted = mountOverflowList(-1);
        const addedCommits = mounted.markCommits();
        const replacement = ITEMS.map(item => ({ id: item.id }));

        mounted.rerenderWith(-1, { items: replacement });

        expect(addedCommits()).toBeLessThanOrEqual(MAX_COMMITS);
        expectAllOverflowed();
    });

    it("keeps every item visible when the spacer is at least one pixel", () => {
        Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
            configurable: true,
            enumerable: true,
            get() {
                return 1;
            },
        });
        const mounted = mountOverflowList(-1);

        expect(spacerWidth()).toBeGreaterThanOrEqual(1);
        expect(mounted.commitCount()).toBeLessThanOrEqual(MAX_COMMITS);
        expectAllVisible();
    });

    it("settles again when a resize notification arrives while the minimum is negative", () => {
        const callbacks: ResizeObserverCallback[] = [];
        vi.stubGlobal(
            "ResizeObserver",
            class {
                public constructor(callback: ResizeObserverCallback) {
                    callbacks.push(callback);
                }

                public observe() {
                    // The component re-reads the spacer on notification. The notification is delivered below.
                }

                public unobserve() {
                    // no stored elements
                }

                public disconnect() {
                    // no stored elements
                }
            },
        );
        const mounted = mountOverflowList(-1, { observeParents: true });
        expect(callbacks.length).toBeGreaterThan(0);
        const addedCommits = mounted.markCommits();

        for (const callback of callbacks) {
            callback([], undefined as unknown as ResizeObserver);
        }

        expect(addedCommits()).toBeLessThanOrEqual(MAX_COMMITS);
        expectAllOverflowed();
    });
});
