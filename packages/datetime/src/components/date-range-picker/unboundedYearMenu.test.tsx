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

import { describe, expect, it } from "@blueprintjs/test-commons/vitest";

import { loadDateFnsLocaleFake } from "../../common/loadDateFnsLocaleFake";
import { DateInput } from "../date-input/dateInput";
import { DatePicker } from "../date-picker/datePicker";
import { DateRangeInput } from "../date-range-input/dateRangeInput";

import { DateRangePicker } from "./dateRangePicker";

/**
 * A year menu may list the years inside a small window. It must not list every
 * year from minDate through maxDate. These tests fail until that bound exists:
 * the JavaScript date limits either throw while the first January is formatted,
 * or a wide range renders one option per year.
 */
const MAX_YEAR_OPTIONS = 100;

/** First and last representable instants. January of the minimum year is not a valid date. */
const JAVASCRIPT_DATE_MIN = new Date(-8640000000000000);
const JAVASCRIPT_DATE_MAX = new Date(8640000000000000);

const localeLoader = { dateFnsLocaleLoader: loadDateFnsLocaleFake };

const dateFormat = {
    formatDate: (date: Date) => String(date.getFullYear()),
    parseDate: (value: string) => new Date(value),
};

function dateInYear(year: number): Date {
    const date = new Date(2020, 0, 1);
    date.setFullYear(year, 0, 1);
    return date;
}

/** Wide enough that one option per year exceeds MAX_YEAR_OPTIONS, and every January is a valid date. */
const WIDE_MIN = dateInYear(1200);
const WIDE_MAX = dateInYear(2200);

function expectBoundedYearMenus() {
    const selects = screen.getAllByLabelText("Year:") as HTMLSelectElement[];
    expect(selects.length).toBeGreaterThan(0);
    for (const select of selects) {
        expect(select.options.length).toBeLessThanOrEqual(MAX_YEAR_OPTIONS);
    }
}

describe("year menus stay bounded", () => {
    describe("non-contiguous DateRangePicker (DatePickerCaption)", () => {
        it("renders the JavaScript date limits without one option per year", () => {
            render(
                <DateRangePicker
                    {...localeLoader}
                    contiguousCalendarMonths={false}
                    maxDate={JAVASCRIPT_DATE_MAX}
                    minDate={JAVASCRIPT_DATE_MIN}
                    shortcuts={false}
                />,
            );
            expectBoundedYearMenus();
        });

        it("does not build one option per year across a millennium-scale range", () => {
            render(
                <DateRangePicker
                    {...localeLoader}
                    contiguousCalendarMonths={false}
                    maxDate={WIDE_MAX}
                    minDate={WIDE_MIN}
                    shortcuts={false}
                />,
            );
            expectBoundedYearMenus();
        }, 30_000);
    });

    describe("contiguous DateRangePicker (react-day-picker YearsDropdown)", () => {
        it("renders the JavaScript date limits without one option per year", () => {
            render(
                <DateRangePicker
                    {...localeLoader}
                    contiguousCalendarMonths={true}
                    maxDate={JAVASCRIPT_DATE_MAX}
                    minDate={JAVASCRIPT_DATE_MIN}
                    shortcuts={false}
                />,
            );
            expectBoundedYearMenus();
        });

        it("does not build one option per year across a millennium-scale range", () => {
            render(
                <DateRangePicker
                    {...localeLoader}
                    contiguousCalendarMonths={true}
                    maxDate={WIDE_MAX}
                    minDate={WIDE_MIN}
                    shortcuts={false}
                />,
            );
            expectBoundedYearMenus();
        }, 30_000);

        it("keeps the single-month range picker bounded", () => {
            render(
                <DateRangePicker
                    {...localeLoader}
                    maxDate={WIDE_MAX}
                    minDate={WIDE_MIN}
                    shortcuts={false}
                    singleMonthOnly={true}
                />,
            );
            expectBoundedYearMenus();
        }, 30_000);
    });

    describe("DatePicker (react-day-picker YearsDropdown)", () => {
        it("renders the JavaScript date limits without one option per year", () => {
            render(
                <DatePicker
                    {...localeLoader}
                    maxDate={JAVASCRIPT_DATE_MAX}
                    minDate={JAVASCRIPT_DATE_MIN}
                    shortcuts={false}
                />,
            );
            expectBoundedYearMenus();
        });

        it("does not build one option per year across a millennium-scale range", () => {
            render(<DatePicker {...localeLoader} maxDate={WIDE_MAX} minDate={WIDE_MIN} shortcuts={false} />);
            expectBoundedYearMenus();
        }, 30_000);
    });

    describe("inputs that mount those pickers", () => {
        const openPopover = { isOpen: true, usePortal: false } as const;

        it("bounds DateRangeInput when the calendars are independent", () => {
            render(
                <DateRangeInput
                    {...localeLoader}
                    {...dateFormat}
                    contiguousCalendarMonths={false}
                    maxDate={WIDE_MAX}
                    minDate={WIDE_MIN}
                    popoverProps={openPopover}
                    shortcuts={false}
                />,
            );
            expectBoundedYearMenus();
        }, 30_000);

        it("bounds DateRangeInput when the calendars are contiguous", () => {
            render(
                <DateRangeInput
                    {...localeLoader}
                    {...dateFormat}
                    contiguousCalendarMonths={true}
                    maxDate={JAVASCRIPT_DATE_MAX}
                    minDate={JAVASCRIPT_DATE_MIN}
                    popoverProps={openPopover}
                    shortcuts={false}
                />,
            );
            expectBoundedYearMenus();
        });

        it("bounds DateInput", () => {
            render(
                <DateInput
                    {...localeLoader}
                    {...dateFormat}
                    maxDate={JAVASCRIPT_DATE_MAX}
                    minDate={JAVASCRIPT_DATE_MIN}
                    popoverProps={openPopover}
                />,
            );
            expectBoundedYearMenus();
        });
    });
});
