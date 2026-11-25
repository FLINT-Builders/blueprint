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
import userEvent from "@testing-library/user-event";
import { createElement } from "react";

import { Menu } from "@blueprintjs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "@blueprintjs/test-commons/vitest";

import { CopyCellsMenuItem, MenuContextImpl } from "../interactions/menus";
import { createTableWithData } from "../mocks/table";
import { Regions } from "../regions";
import { Table } from "../table";

import * as Classes from "./classes";
import { Clipboard } from "./clipboard";

/**
 * Clipboard text these tests require before a selection is safe to paste into a spreadsheet.
 * A cell that starts with =, +, -, or @ is prefixed with a single quote. A cell that contains
 * a tab, a newline (\n or \r), or a double quote is wrapped in double quotes, and each
 * double quote inside it is doubled. The prefix is applied before quoting so the parsed
 * field still begins with the text marker. Null and undefined stay empty fields.
 */
function escapeClipboardCell(value: unknown): string {
    if (value == null) {
        return "";
    }
    let text = String(value);
    if (text.length > 0 && "=+-@".includes(text[0])) {
        text = `'${text}`;
    }
    if (/[\t\n\r"]/.test(text)) {
        text = `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

function escapeClipboardTable(cells: unknown[][]): string {
    return cells.map(row => row.map(cell => escapeClipboardCell(cell)).join("\t")).join("\n");
}

const STORED_CELLS = [
    ["plain", "=SUM(A1:A2)", "+1+1", "-2+3", "@SUM(1)"],
    ["left\tright", "line1\nline2", 'say "hi"', "=1+1\t=2+2", "ok\r\n=1+1"],
];

describe("table copy spreadsheet escaping", () => {
    let written: string[];

    beforeEach(() => {
        written = [];
        navigator.clipboard.writeText = (data: string) => {
            written.push(data);
            return Promise.resolve();
        };
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("Clipboard.copyCells", () => {
        it("leaves ordinary text and empty fields as tab-separated rows", async () => {
            const cells = [
                ["Revenue", "safe = text", null, 12],
                ["", "a=b", undefined, "  spaced"],
            ];

            await Clipboard.copyCells(cells as string[][]);

            expect(written).to.deep.equal([escapeClipboardTable(cells)]);
        });

        it("neutralizes formula prefixes and structural characters inside a cell", async () => {
            await Clipboard.copyCells(STORED_CELLS);

            const payload = written[0] ?? "";
            expect(payload).to.equal(escapeClipboardTable(STORED_CELLS));
            // A leading "=" or an unquoted tab must not remain spreadsheet syntax.
            expect(payload.startsWith("plain\t=SUM")).to.equal(false);
            expect(payload.includes("\t=1+1\t")).to.equal(false);
            expect(payload.includes('"line1\nline2"')).to.equal(true);
        });
    });

    describe("default table copy hotkey", () => {
        it("escapes rendered cell text copied with the default mod+c hotkey", async () => {
            const onCopy = vi.fn();
            const { container } = render(
                createTableWithData(
                    ["A", "B", "C", "D", "E"],
                    STORED_CELLS,
                    {},
                    {
                        onCopy,
                        selectedRegions: [Regions.table()],
                    },
                ),
            );
            const table = container.querySelector(`.${Classes.TABLE_CONTAINER}`);
            expect(table).to.not.equal(null);

            fireEvent.keyDown(table!, copyKeyInit());
            await vi.waitFor(() => {
                expect(onCopy).toHaveBeenCalled();
            });

            expect(onCopy.mock.calls[0][0]).to.equal(true);
            expect(written).to.deep.equal([escapeClipboardTable(STORED_CELLS)]);
            expect(Table.defaultProps.getCellClipboardData).to.not.equal(undefined);
        });

        it("escapes strings returned by a host getCellClipboardData callback", async () => {
            const stored = [
                ['=HYPERLINK("http://example.invalid","x")', "safe"],
                ["left\tright", "top\n=1+1"],
            ];
            const onCopy = vi.fn();
            const { container } = render(
                createTableWithData(
                    ["A", "B"],
                    stored,
                    {},
                    {
                        getCellClipboardData: (row: number, col: number) => stored[row][col],
                        onCopy,
                        selectedRegions: [Regions.table()],
                    },
                ),
            );
            const table = container.querySelector(`.${Classes.TABLE_CONTAINER}`);

            fireEvent.keyDown(table!, copyKeyInit());
            await vi.waitFor(() => {
                expect(onCopy).toHaveBeenCalled();
            });

            expect(written).to.deep.equal([escapeClipboardTable(stored)]);
        });
    });

    describe("CopyCellsMenuItem", () => {
        it("writes the same escaped table when the menu item copies stored cell text", async () => {
            const stored = [
                ["=1+1", "keep"],
                ["a\tb", 'he said "hi"\n=2+2'],
            ];
            const context = new MenuContextImpl(Regions.cell(0, 0), [Regions.cell(0, 0, 1, 1)], 2, 2);
            const getCellData = (row: number, col: number) => stored[row][col];
            render(
                createElement(
                    Menu,
                    null,
                    createElement(CopyCellsMenuItem, {
                        context,
                        getCellData,
                        text: "Copy",
                    }),
                ),
            );

            await userEvent.click(screen.getByText("Copy"));
            await vi.waitFor(() => {
                expect(written.length).to.equal(1);
            });

            expect(written).to.deep.equal([escapeClipboardTable(stored)]);
        });
    });
});

function copyKeyInit(): KeyboardEventInit {
    // Match HotkeyParser's "mod" alias, which reads navigator.platform.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const isApplePlatform = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
    return {
        bubbles: true,
        code: "KeyC",
        ctrlKey: !isApplePlatform,
        key: "c",
        metaKey: isApplePlatform,
    };
}
