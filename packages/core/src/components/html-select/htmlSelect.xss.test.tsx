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

import { render, screen } from "@testing-library/react";

import { describe, expect, it } from "@blueprintjs/test-commons/vitest";

import { HTMLSelect, type HTMLSelectProps } from "./htmlSelect";

/**
 * Marker incremented by the option markup under test. Stored option objects are parsed from
 * JSON, so the only way this can change is if that markup is assigned as the option's HTML.
 */
const MARKER = "htmlSelectOptionMarkupMarker";

function markupField() {
    return {
        dangerouslySetInnerHTML: {
            __html: `<img alt="injected" src="x" onerror="window['${MARKER}']++">`,
        },
    };
}

/** Plain JSON objects, as an application would load from stored or API data. */
function optionsFromJson(options: readonly unknown[]): HTMLSelectProps["options"] {
    return JSON.parse(JSON.stringify(options)) as HTMLSelectProps["options"];
}

function markerCount(): number {
    return (window as unknown as Record<string, number | undefined>)[MARKER] ?? 0;
}

function expectOptionTextOnly(option: HTMLElement) {
    expect(option.querySelector("img")).toBeNull();
    expect(option.innerHTML.toLowerCase()).not.toContain("onerror");
    expect(option.innerHTML).not.toContain("injected");
    expect(markerCount()).toBe(0);
}

// Fails until HTMLSelect copies only className, disabled, label, and value from each option.
describe("<HTMLSelect> option fields from stored JSON", () => {
    it("does not render a raw HTML field when an option has no label and no value", () => {
        (window as unknown as Record<string, number>)[MARKER] = 0;
        render(<HTMLSelect options={optionsFromJson([markupField()])} />);

        expectOptionTextOnly(screen.getByRole("option"));
    });

    it("does not render a raw HTML field when label and value are null", () => {
        (window as unknown as Record<string, number>)[MARKER] = 0;
        render(<HTMLSelect options={optionsFromJson([{ ...markupField(), label: null, value: null }])} />);

        expectOptionTextOnly(screen.getByRole("option"));
    });

    it("does not render a raw HTML field when label is empty and value is omitted", () => {
        (window as unknown as Record<string, number>)[MARKER] = 0;
        render(<HTMLSelect options={optionsFromJson([{ ...markupField(), label: "" }])} />);

        expectOptionTextOnly(screen.getByRole("option"));
    });

    it("does not render a raw HTML field added to an existing option on update", () => {
        (window as unknown as Record<string, number>)[MARKER] = 0;
        const { rerender } = render(<HTMLSelect options={optionsFromJson([{}])} />);
        expectOptionTextOnly(screen.getByRole("option"));

        rerender(<HTMLSelect options={optionsFromJson([markupField()])} />);

        expectOptionTextOnly(screen.getByRole("option"));
    });

    it("does not render a raw HTML field on one option when another option is a plain string", () => {
        (window as unknown as Record<string, number>)[MARKER] = 0;
        render(<HTMLSelect options={optionsFromJson(["safe", markupField()])} />);

        const rendered = screen.getAllByRole("option");
        expect(rendered).toHaveLength(2);
        expect(rendered[0]).toHaveTextContent("safe");
        expect(rendered[0]).toHaveValue("safe");
        expectOptionTextOnly(rendered[1]);
    });

    it("renders label and value as text when an option also carries a raw HTML field", () => {
        (window as unknown as Record<string, number>)[MARKER] = 0;
        render(
            <HTMLSelect options={optionsFromJson([{ ...markupField(), label: "Visible label", value: "visible" }])} />,
        );

        const option = screen.getByRole("option", { name: "Visible label" });
        expect(option).toHaveValue("visible");
        expect(option).toHaveTextContent("Visible label");
        expectOptionTextOnly(option);
    });

    it("renders a numeric zero value as text when an option also carries a raw HTML field", () => {
        (window as unknown as Record<string, number>)[MARKER] = 0;
        render(<HTMLSelect options={optionsFromJson([{ ...markupField(), value: 0 }])} />);

        const option = screen.getByRole("option", { name: "0" });
        expect(option).toHaveValue("0");
        expect(option).toHaveTextContent("0");
        expectOptionTextOnly(option);
    });

    it("renders an empty value as text when an option also carries a raw HTML field", () => {
        (window as unknown as Record<string, number>)[MARKER] = 0;
        render(<HTMLSelect options={optionsFromJson([{ ...markupField(), label: "", value: "" }])} />);

        const option = screen.getByRole("option");
        expect(option).toHaveValue("");
        expect(option).toHaveTextContent("");
        expectOptionTextOnly(option);
    });
});
