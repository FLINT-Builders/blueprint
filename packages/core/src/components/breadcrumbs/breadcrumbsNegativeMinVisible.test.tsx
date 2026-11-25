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
import { Profiler, type ProfilerOnRenderCallback, type ReactElement } from "react";

import { describe, expect, it } from "@blueprintjs/test-commons/vitest";

import { Boundary, Classes } from "../../common";

import type { BreadcrumbProps } from "./breadcrumb";
import { Breadcrumbs } from "./breadcrumbs";

/**
 * Breadcrumbs forwards `minVisibleItems` into OverflowList, then spreads `overflowListProps`
 * afterwards, so a negative minimum on either prop reaches the same repartition loop.
 */

const ITEMS: BreadcrumbProps[] = [{ text: "Home" }, { text: "Library" }, { text: "Data" }];

/** Includes popover work, but a finite partition of three breadcrumbs stays well under this. */
const MAX_COMMITS = 40;

function spacerWidth(): number {
    const spacer = document.querySelector(`.${Classes.OVERFLOW_LIST_SPACER}`);
    expect(spacer).toBeInstanceOf(HTMLElement);
    return (spacer as HTMLElement).offsetWidth;
}

function expectFullyCollapsed() {
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /collapsed breadcrumbs/i })).toBeInTheDocument();
    expect(screen.queryByText("Home")).not.toBeInTheDocument();
    expect(screen.queryByText("Library")).not.toBeInTheDocument();
    expect(screen.queryByText("Data")).not.toBeInTheDocument();
}

function mountBreadcrumbs(element: (onRender: ProfilerOnRenderCallback) => ReactElement) {
    let commits = 0;
    const onRender: ProfilerOnRenderCallback = () => {
        commits += 1;
        if (commits > MAX_COMMITS) {
            throw new Error(`Breadcrumbs did not settle after ${MAX_COMMITS} commits`);
        }
    };
    const view = render(element(onRender));
    return {
        commitCount: () => commits,
        rerenderWith(next: (onRender: ProfilerOnRenderCallback) => ReactElement) {
            view.rerender(next(onRender));
        },
    };
}

describe("Breadcrumbs negative minVisibleItems", () => {
    it("settles when minVisibleItems is negative and the spacer is under one pixel", () => {
        const mounted = mountBreadcrumbs(onRender => (
            <Profiler id="breadcrumbs" onRender={onRender}>
                <Breadcrumbs items={ITEMS} minVisibleItems={-1} />
            </Profiler>
        ));

        expect(spacerWidth()).toBeLessThan(0.9);
        expect(mounted.commitCount()).toBeLessThanOrEqual(MAX_COMMITS);
        expectFullyCollapsed();
    });

    it("settles when overflowListProps overrides a non-negative minimum with a negative one", () => {
        const mounted = mountBreadcrumbs(onRender => (
            <Profiler id="breadcrumbs" onRender={onRender}>
                <Breadcrumbs items={ITEMS} minVisibleItems={ITEMS.length} overflowListProps={{ minVisibleItems: -1 }} />
            </Profiler>
        ));

        expect(spacerWidth()).toBeLessThan(0.9);
        expect(mounted.commitCount()).toBeLessThanOrEqual(MAX_COMMITS);
        expectFullyCollapsed();
    });

    it("settles after the breadcrumb minimum changes to a negative number", () => {
        const mounted = mountBreadcrumbs(onRender => (
            <Profiler id="breadcrumbs" onRender={onRender}>
                <Breadcrumbs items={ITEMS} minVisibleItems={0} />
            </Profiler>
        ));
        expectFullyCollapsed();

        mounted.rerenderWith(onRender => (
            <Profiler id="breadcrumbs" onRender={onRender}>
                <Breadcrumbs items={ITEMS} minVisibleItems={-1} />
            </Profiler>
        ));

        expect(mounted.commitCount()).toBeLessThanOrEqual(MAX_COMMITS);
        expectFullyCollapsed();
    });

    it.each([Boundary.START, Boundary.END])("settles when breadcrumbs collapse from %s", collapseFrom => {
        const mounted = mountBreadcrumbs(onRender => (
            <Profiler id="breadcrumbs" onRender={onRender}>
                <Breadcrumbs collapseFrom={collapseFrom} items={ITEMS} minVisibleItems={-1} />
            </Profiler>
        ));

        expect(mounted.commitCount()).toBeLessThanOrEqual(MAX_COMMITS);
        expectFullyCollapsed();
    });
});
