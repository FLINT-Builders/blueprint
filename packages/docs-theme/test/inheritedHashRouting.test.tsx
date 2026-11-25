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

import type { PageData } from "@documentalist/client";
import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DocsData } from "../src/common/context";
import { Documentation } from "../src/components/documentation";

/**
 * Names that a plain object inherits from Object.prototype.
 * Looking any of these up with bracket access returns a value that is not undefined.
 */
const INHERITED_SECTION_IDS = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "__proto__",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
] as const;

const DEFAULT_PAGE_ID = "home-ref";
const GUIDE_PAGE_ID = "guide-ref";

/**
 * Pages are JSON data in the docs app (packages/docs-data/src/index.js loads docs.json).
 * Parse a JSON payload so the pages map is a prototype-bearing object, matching that load path.
 */
function createDocs(): DocsData {
    const home = createPage(DEFAULT_PAGE_ID, "home", "Home page body");
    const guide = createPage(GUIDE_PAGE_ID, "guide", "Guide page body");
    const payload = {
        nav: [
            {
                children: [],
                level: 1,
                reference: DEFAULT_PAGE_ID,
                route: "home",
                title: "Home",
            },
            {
                children: [{ level: 2, route: "guide/intro", title: "Intro" }],
                level: 1,
                reference: GUIDE_PAGE_ID,
                route: "guide",
                title: "Guide",
            },
        ],
        pages: {
            [DEFAULT_PAGE_ID]: home,
            [GUIDE_PAGE_ID]: guide,
        },
    };
    return JSON.parse(JSON.stringify(payload)) as DocsData;
}

function createPage(reference: string, route: string, title: string): PageData {
    return {
        contents: [`<p>${title}</p>`],
        contentsRaw: title,
        metadata: {},
        reference,
        route,
        sourcePath: `${reference}.md`,
        title,
    };
}

function installAnalyticsStub() {
    // packages/docs-app/src/index.html defines window.ga before the app boots on blueprintjs.com.
    const ga = (...args: unknown[]) => {
        ga.calls.push(args);
    };
    ga.calls = [] as unknown[][];
    (window as unknown as { ga: typeof ga }).ga = ga;
    return ga;
}

function setLocationHash(hash: string) {
    window.location.hash = hash.startsWith("#") ? hash : `#${hash}`;
}

async function flushHashChange() {
    await act(async () => {
        await new Promise(resolve => {
            setTimeout(resolve, 0);
        });
    });
}

function renderDocumentation() {
    return render(
        <StrictMode>
            <Documentation
                defaultPageId={DEFAULT_PAGE_ID}
                docs={createDocs()}
                header={<div>Docs header</div>}
                tagRenderers={{}}
            />
        </StrictMode>,
    );
}

function expectDefaultPage() {
    expect(screen.getByText("Home page body")).toBeInTheDocument();
    // Page renders data-page-id from PageData.route, which is distinct from the page reference.
    expect(document.querySelector('[data-page-id="home"]')).not.toBeNull();
    expect(document.querySelector(".docs-root")).not.toBeNull();
}

function expectGuidePage() {
    expect(screen.getByText("Guide page body")).toBeInTheDocument();
    expect(document.querySelector('[data-page-id="guide"]')).not.toBeNull();
}

describe("Documentation hash routing", () => {
    beforeEach(() => {
        installAnalyticsStub();
        setLocationHash("");
    });

    afterEach(async () => {
        await flushHashChange();
        cleanup();
        setLocationHash("");
        await flushHashChange();
    });

    it("renders the default page when the URL has no hash", async () => {
        renderDocumentation();
        await flushHashChange();
        expectDefaultPage();
    });

    it("renders a page whose route is an own key of the route map", async () => {
        setLocationHash("guide");
        await flushHashChange();
        renderDocumentation();
        await flushHashChange();
        expectGuidePage();
    });

    it("renders the parent page for a heading route stored on the route map", async () => {
        setLocationHash("guide/intro");
        await flushHashChange();
        renderDocumentation();
        await flushHashChange();
        expectGuidePage();
    });

    it("keeps the default page when the hash is not a route", async () => {
        setLocationHash("missing-section");
        await flushHashChange();
        renderDocumentation();
        await flushHashChange();
        expectDefaultPage();
    });

    it("navigates when hashchange names an own route", async () => {
        renderDocumentation();
        await flushHashChange();
        expectDefaultPage();

        setLocationHash("guide");
        await flushHashChange();
        expectGuidePage();
    });

    it("keeps the current page when hashchange names an unknown route", async () => {
        renderDocumentation();
        await flushHashChange();
        expectDefaultPage();

        setLocationHash("missing-section");
        await flushHashChange();
        expectDefaultPage();
    });

    it.each(INHERITED_SECTION_IDS)(
        "opening a link whose hash is #%s still renders the default page",
        async sectionId => {
            setLocationHash(sectionId);
            await flushHashChange();
            renderDocumentation();
            await flushHashChange();

            expect(window.location.hash.slice(1)).toBe(sectionId);
            expectDefaultPage();
        },
    );

    it.each(INHERITED_SECTION_IDS)(
        "hashchange to #%s leaves the documentation tree mounted on the default page",
        async sectionId => {
            renderDocumentation();
            await flushHashChange();
            expectDefaultPage();

            setLocationHash(sectionId);
            await flushHashChange();

            expect(window.location.hash.slice(1)).toBe(sectionId);
            expectDefaultPage();
            if (location.hostname.indexOf("blueprint") !== -1) {
                const ga = (window as unknown as { ga: { calls: unknown[][] } }).ga;
                expect(ga.calls.length).toBeGreaterThan(0);
            }
        },
    );
});
