/*
 * Copyright 2016 Palantir Technologies, Inc. All rights reserved.
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

// Spreadsheets interpret a field starting with one of these (optionally after whitespace) as a formula.
// Full-width variants are included because some spreadsheet locales normalize them to their ASCII forms.
const FORMULA_PREFIX = /^(?:[\t\r]|\s*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20])/;
const TSV_STRUCTURAL_CHARS = /[\t\n\r"]/;

/**
 * Escapes a single cell so that, when pasted into a spreadsheet, it is read as one literal text field.
 * Formula-like values are prefixed with a single quote, and values containing tabs, line breaks, or double
 * quotes are wrapped in double quotes with inner double quotes doubled.
 */
function escapeTsvCell(value: unknown): string {
    if (value == null) {
        return "";
    }
    let text = String(value);
    if (FORMULA_PREFIX.test(text)) {
        text = `'${text}`;
    }
    if (TSV_STRUCTURAL_CHARS.test(text)) {
        text = `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

/* istanbul ignore next */

export const Clipboard = {
    /**
     * Copies table cells to the clipboard. The parameter is a row-major
     * 2-dimensional `Array` of strings and can contain nulls. We assume all
     * rows are the same length. If not, the cells will still be copied, but
     * the columns may not align.
     *
     * Each cell is escaped so that spreadsheet formulas and embedded tabs or
     * line breaks are pasted as literal text within a single cell.
     *
     * @returns a Promise which resolves or rejects if the copy succeeds.
     *
     * See `Clipboard.copy`
     */
    copyCells(cells: string[][]) {
        const tsv = cells.map(row => row.map(escapeTsvCell).join("\t")).join("\n");
        return navigator.clipboard.writeText(tsv);
    },

    /**
     * Copies the text to the clipboard.
     *
     * @returns a Promise which resolves or rejects if the copy succeeds.
     */
    copyString(value: string) {
        return navigator.clipboard.writeText(value);
    },
};
