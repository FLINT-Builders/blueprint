/*
 * Copyright 2023 Palantir Technologies, Inc. All rights reserved.
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

import type { DateRange as RDPRange } from "react-day-picker";

import type { DateRange } from "./dateRange";

/**
 * Converts a Blueprint `DateRange` to a react-day-picker `DateRange`.
 */
export function dateRangeToDayPickerRange(range: DateRange): RDPRange {
    return { from: range[0] ?? undefined, to: range[1] ?? undefined };
}

/**
 * Upper bound on the number of options rendered in a year dropdown. `minDate` and `maxDate` may be arbitrarily
 * far apart (up to the JavaScript date limits), so year dropdowns list a window of years around the displayed
 * year instead of every year in the range.
 */
export const MAX_YEAR_OPTIONS = 100;

/**
 * Returns the inclusive `[firstYear, lastYear]` window of selectable years to list in a year dropdown.
 * The window is clamped to `[minYear, maxYear]`, contains `displayYear` when it is within those bounds,
 * and spans at most `maxOptions` years.
 */
export function getYearOptionsWindow(
    minYear: number,
    maxYear: number,
    displayYear: number,
    maxOptions: number = MAX_YEAR_OPTIONS,
): [number, number] {
    const size = Math.max(1, Math.floor(maxOptions));
    if (maxYear - minYear + 1 <= size) {
        return [minYear, maxYear];
    }
    const centeredFirstYear = Math.min(Math.max(displayYear, minYear), maxYear) - Math.floor((size - 1) / 2);
    const firstYear = Math.min(Math.max(centeredFirstYear, minYear), maxYear - size + 1);
    return [firstYear, firstYear + size - 1];
}

/**
 * Returns a valid date within the given month suitable for formatting a caption, or `undefined` if no such date
 * can be represented. The first day of some months near the JavaScript date limits is not representable, and
 * `new Date(year, month)` maps years 0-99 to 1900-1999, so this helper avoids both pitfalls.
 */
export function getMonthCaptionDate(year: number, month: number): Date | undefined {
    for (const day of [1, 28]) {
        const date = new Date(2000, 0, 1);
        date.setFullYear(year, month, day);
        if (!isNaN(date.getTime())) {
            return date;
        }
    }
    return undefined;
}

/**
 * Returns a valid date within `year` suitable for formatting a year caption, or `undefined` if no such date can
 * be represented.
 */
export function getYearCaptionDate(year: number): Date | undefined {
    return getMonthCaptionDate(year, 0) ?? getMonthCaptionDate(year, 11);
}
