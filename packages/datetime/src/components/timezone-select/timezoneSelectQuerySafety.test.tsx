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

import { fireEvent, render, screen } from "@testing-library/react";

import { describe, expect, it } from "@blueprintjs/test-commons/vitest";

import { loadDateFnsLocaleFake } from "../../common/loadDateFnsLocaleFake";
import { TimePrecision } from "../../common/timePrecision";
import { DateInput } from "../date-input/dateInput";

import { TimezoneSelect } from "./timezoneSelect";

/**
 * Seven copies of `.{0,}` plus a trailing letter. The letter is not required
 * for the hang; it keeps the expression from succeeding on the first attempt
 * against ordinary timezone names. Measured against the built-in timezone
 * list, this query spends many seconds inside `RegExp.prototype.test`.
 */
const BACKTRACKING_QUERY = `${".{0,}".repeat(7)}q`;

/** A fixed literal comparison of the same list finishes well under this. */
const FILTER_BUDGET_MS = 500;

describe("timezone search query safety", () => {
    it("filters a backtracking query within the time budget", () => {
        renderTimezoneSelect();
        const elapsed = pasteQuery(BACKTRACKING_QUERY);

        expect(elapsed).toBeLessThan(FILTER_BUDGET_MS);
        expect(searchInput()).toHaveValue(BACKTRACKING_QUERY);
        expect(screen.getByText("No matching timezones.")).toBeInTheDocument();
    }, 60_000);

    it("applies a trailing backslash without aborting the search update", () => {
        renderTimezoneSelect();

        expect(() => pasteQuery("\\")).not.toThrow();
        expect(searchInput()).toHaveValue("\\");
        expect(screen.getByText("No matching timezones.")).toBeInTheDocument();
    });

    it("applies a brace quantifier with nothing to repeat without aborting the search update", () => {
        renderTimezoneSelect();

        expect(() => pasteQuery("{0}")).not.toThrow();
        expect(searchInput()).toHaveValue("{0}");
        expect(screen.getByText("No matching timezones.")).toBeInTheDocument();
    });

    it("applies an open-ended brace quantifier without aborting the search update", () => {
        renderTimezoneSelect();

        expect(() => pasteQuery("{0,}")).not.toThrow();
        expect(searchInput()).toHaveValue("{0,}");
        expect(screen.getByText("No matching timezones.")).toBeInTheDocument();
    });

    it("treats dots as literal characters", () => {
        renderTimezoneSelect();
        pasteQuery("....");

        expect(searchInput()).toHaveValue("....");
        expect(screen.getByText("No matching timezones.")).toBeInTheDocument();
        expect(screen.queryByText(/Los Angeles,/)).not.toBeInTheDocument();
    });

    it("treats an unescaped pipe as a literal character", () => {
        renderTimezoneSelect();
        pasteQuery("Los|Angeles");

        expect(searchInput()).toHaveValue("Los|Angeles");
        expect(screen.getByText("No matching timezones.")).toBeInTheDocument();
    });

    it("still matches timezone labels with a case-insensitive literal query", () => {
        renderTimezoneSelect();
        pasteQuery("los angeles");

        expect(screen.getByText(/Los Angeles,/)).toBeInTheDocument();
        expect(screen.queryByText("No matching timezones.")).not.toBeInTheDocument();
    });

    it("still matches timezone codes ignoring case", () => {
        renderTimezoneSelect();
        pasteQuery("TOKYO");

        expect(screen.getByText(/Tokyo,/)).toBeInTheDocument();
    });

    it("still treats a space as a separator between query words", () => {
        renderTimezoneSelect();
        pasteQuery("pacific pago");

        // "Pacific/Pago_Pago" only matches when the space can stand for "/" or "_".
        expect(screen.getByText(/Pago Pago,/)).toBeInTheDocument();
    });

    describe("date input timezone picker", () => {
        it("filters a backtracking query from the date field timezone search", () => {
            renderDateInput();
            openDateInputTimezoneSearch();
            const elapsed = pasteQuery(BACKTRACKING_QUERY);

            expect(elapsed).toBeLessThan(FILTER_BUDGET_MS);
            expect(searchInput()).toHaveValue(BACKTRACKING_QUERY);
        }, 60_000);

        it("applies a trailing backslash in the date field timezone search", () => {
            renderDateInput();
            openDateInputTimezoneSearch();

            expect(() => pasteQuery("\\")).not.toThrow();
            expect(searchInput()).toHaveValue("\\");
        });

        it("still finds a timezone from the date field search", () => {
            renderDateInput();
            openDateInputTimezoneSearch();
            pasteQuery("tokyo");

            expect(screen.getByText(/Tokyo,/)).toBeInTheDocument();
        });
    });
});

function renderTimezoneSelect() {
    render(
        <TimezoneSelect
            onChange={() => undefined}
            popoverProps={{ isOpen: true, usePortal: false }}
            value="America/Los_Angeles"
        />,
    );
}

function renderDateInput() {
    render(
        <DateInput
            dateFnsLocaleLoader={loadDateFnsLocaleFake}
            formatDate={date => (date == null ? "" : date.toISOString())}
            parseDate={str => new Date(str)}
            popoverProps={{ usePortal: false }}
            showTimezoneSelect={true}
            timePrecision={TimePrecision.MINUTE}
        />,
    );
}

function openDateInputTimezoneSearch() {
    fireEvent.click(screen.getByLabelText("timezone"));
    expect(searchInput()).toBeInTheDocument();
}

function searchInput() {
    return screen.getByPlaceholderText("Search for timezones...") as HTMLInputElement;
}

/**
 * One change event, the same event React delivers for a pasted value.
 * Returns how long the input handler took, including filtering.
 */
function pasteQuery(value: string): number {
    const input = searchInput();
    const started = performance.now();
    fireEvent.change(input, { target: { value } });
    return performance.now() - started;
}
