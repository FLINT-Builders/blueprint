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

import { addMonths, isSameYear, setMonth, setYear, startOfMonth } from "date-fns";
import { useCallback } from "react";
import {
    Caption,
    CaptionLabel,
    CaptionNavigation,
    type CaptionProps,
    Dropdown,
    useDayPicker,
    useNavigation,
} from "react-day-picker";

import { DISPLAYNAME_PREFIX } from "@blueprintjs/core";

import { getYearCaptionDate, getYearOptionsWindow } from "../../common/reactDayPickerUtils";

interface CaptionDropdownProps {
    displayMonth: Date;
    onChange: (month: Date) => void;
}

/**
 * Custom react-day-picker caption component used when `captionLayout` is `"dropdown"` or `"dropdown-buttons"`.
 *
 * It renders the same markup as react-day-picker's built-in caption, except that the year dropdown lists a bounded
 * window of years around the displayed month instead of one option for every year between `fromDate` and `toDate`.
 * react-day-picker does not allow overriding its built-in year dropdown, so the whole caption is replaced.
 *
 * @see https://daypicker.dev/guides/custom-components
 */
export const DatePickerCaptionDropdowns = (props: CaptionProps) => {
    const { captionLayout, classNames, components, disableNavigation, styles } = useDayPicker();
    const { goToMonth } = useNavigation();
    const { displayIndex, displayMonth, id } = props;

    const handleMonthChange = useCallback(
        (newMonth: Date) => goToMonth(addMonths(newMonth, displayIndex ? -displayIndex : 0)),
        [displayIndex, goToMonth],
    );

    if (disableNavigation || (captionLayout !== "dropdown" && captionLayout !== "dropdown-buttons")) {
        return <Caption {...props} />;
    }

    const CaptionLabelComponent = components?.CaptionLabel ?? CaptionLabel;

    return (
        <div className={classNames.caption} style={styles.caption}>
            <div className={classNames.caption_dropdowns} style={styles.caption_dropdowns}>
                <div className={classNames.vhidden}>
                    <CaptionLabelComponent displayMonth={displayMonth} id={id} />
                </div>
                <MonthsDropdown displayMonth={displayMonth} onChange={handleMonthChange} />
                <YearsDropdown displayMonth={displayMonth} onChange={handleMonthChange} />
            </div>
            {captionLayout === "dropdown-buttons" && (
                <CaptionNavigation displayIndex={displayIndex} displayMonth={displayMonth} id={id} />
            )}
        </div>
    );
};
DatePickerCaptionDropdowns.displayName = `${DISPLAYNAME_PREFIX}.DatePickerCaptionDropdowns`;

function MonthsDropdown({ displayMonth, onChange }: CaptionDropdownProps) {
    const {
        classNames,
        components,
        formatters: { formatMonthCaption },
        fromDate,
        labels: { labelMonthDropdown },
        locale,
        styles,
        toDate,
    } = useDayPicker();

    const handleChange = useCallback(
        (e: React.ChangeEvent<HTMLSelectElement>) => {
            onChange(setMonth(startOfMonth(displayMonth), Number(e.target.value)));
        },
        [displayMonth, onChange],
    );

    if (fromDate == null || toDate == null) {
        return null;
    }

    const dropdownMonths: Date[] = [];
    if (isSameYear(fromDate, toDate)) {
        const date = startOfMonth(fromDate);
        for (let month = fromDate.getMonth(); month <= toDate.getMonth(); month++) {
            dropdownMonths.push(setMonth(date, month));
        }
    } else {
        const date = startOfMonth(new Date());
        for (let month = 0; month <= 11; month++) {
            dropdownMonths.push(setMonth(date, month));
        }
    }

    const DropdownComponent = components?.Dropdown ?? Dropdown;
    return (
        <DropdownComponent
            aria-label={labelMonthDropdown()}
            caption={formatMonthCaption(displayMonth, { locale })}
            className={classNames.dropdown_month}
            name="months"
            onChange={handleChange}
            style={styles.dropdown_month}
            value={displayMonth.getMonth()}
        >
            {dropdownMonths.map(month => (
                <option key={month.getMonth()} value={month.getMonth()}>
                    {formatMonthCaption(month, { locale })}
                </option>
            ))}
        </DropdownComponent>
    );
}

function YearsDropdown({ displayMonth, onChange }: CaptionDropdownProps) {
    const {
        classNames,
        components,
        formatters: { formatYearCaption },
        fromDate,
        labels: { labelYearDropdown },
        locale,
        styles,
        toDate,
    } = useDayPicker();

    const handleChange = useCallback(
        (e: React.ChangeEvent<HTMLSelectElement>) => {
            onChange(setYear(startOfMonth(displayMonth), Number(e.target.value)));
        },
        [displayMonth, onChange],
    );

    if (fromDate == null || toDate == null) {
        return null;
    }

    const displayYear = displayMonth.getFullYear();
    const [firstYear, lastYear] = getYearOptionsWindow(fromDate.getFullYear(), toDate.getFullYear(), displayYear);
    const options: React.JSX.Element[] = [];
    for (let year = firstYear; year <= lastYear; year++) {
        const yearDate = getYearCaptionDate(year);
        if (yearDate !== undefined) {
            options.push(
                <option key={year} value={year}>
                    {formatYearCaption(yearDate, { locale })}
                </option>,
            );
        }
    }

    const DropdownComponent = components?.Dropdown ?? Dropdown;
    return (
        <DropdownComponent
            aria-label={labelYearDropdown()}
            caption={formatYearCaption(displayMonth, { locale })}
            className={classNames.dropdown_year}
            name="years"
            onChange={handleChange}
            style={styles.dropdown_year}
            value={displayYear}
        >
            {options}
        </DropdownComponent>
    );
}
