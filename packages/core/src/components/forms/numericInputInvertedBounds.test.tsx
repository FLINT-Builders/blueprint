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
import { useState } from "react";

import { H1 } from "@blueprintjs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "@blueprintjs/test-commons/vitest";

import { NumericInput } from "./numericInput";

/**
 * Inverted `min`/`max` is a user-reachable prop state (a from/to range bound to this control).
 * The control already reports that state, and it must keep rendering the supplied value instead of
 * throwing from `clamp` while deriving state, validating props, stepping, or clamping on blur.
 *
 * These tests fail while that throw is still reachable.
 */

const INVERTED_MIN = 20;
const INVERTED_MAX = 10;
const SUPPLIED_VALUE = 100;

function expectSuppliedValue(value: string = String(SUPPLIED_VALUE)) {
    expect(screen.getByRole("spinbutton")).toHaveValue(value);
}

describe("<NumericInput> inverted min and max", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    beforeEach(() => {
        consoleError.mockClear();
    });

    afterEach(() => {
        consoleError.mockClear();
    });

    describe("state derivation", () => {
        it("renders a controlled value when min is greater than max", () => {
            render(
                <section>
                    <H1>Invoices</H1>
                    <NumericInput min={INVERTED_MIN} max={INVERTED_MAX} value={SUPPLIED_VALUE} />
                </section>,
            );

            expect(screen.getByRole("heading", { name: "Invoices" })).toBeInTheDocument();
            expectSuppliedValue();
        });

        it("renders a string value when min is greater than max", () => {
            render(<NumericInput min={INVERTED_MIN} max={INVERTED_MAX} value="100.5" />);
            expectSuppliedValue("100.5");
        });

        it("renders a zero value when min is greater than max", () => {
            // 0 is outside the swapped interval [10, 20], so swapping the bounds and clamping
            // would display 10. The supplied value must be left alone.
            render(<NumericInput min={INVERTED_MIN} max={INVERTED_MAX} value={0} />);
            expectSuppliedValue("0");
        });

        it("renders a negative value when min is greater than max", () => {
            render(<NumericInput min={-1} max={-5} value={-20} />);
            expectSuppliedValue("-20");
        });

        it("renders defaultValue when min is greater than max", () => {
            render(<NumericInput min={INVERTED_MIN} max={INVERTED_MAX} defaultValue={SUPPLIED_VALUE} />);
            expectSuppliedValue();
        });

        it("keeps the current value when a later update inverts min and max", () => {
            const { rerender } = render(
                <section>
                    <H1>Invoices</H1>
                    <NumericInput min={0} max={200} value={SUPPLIED_VALUE} />
                </section>,
            );
            expectSuppliedValue();

            rerender(
                <section>
                    <H1>Invoices</H1>
                    <NumericInput min={INVERTED_MIN} max={INVERTED_MAX} value={SUPPLIED_VALUE} />
                </section>,
            );

            expect(screen.getByRole("heading", { name: "Invoices" })).toBeInTheDocument();
            expectSuppliedValue();
        });

        it("shows a value supplied after min and max are already inverted", () => {
            const { rerender } = render(<NumericInput min={INVERTED_MIN} max={INVERTED_MAX} value="" />);
            expect(screen.getByRole("spinbutton")).toHaveValue("");

            rerender(<NumericInput min={INVERTED_MIN} max={INVERTED_MAX} value={SUPPLIED_VALUE} />);
            expectSuppliedValue();
        });

        it("derives state for an inverted range without throwing", () => {
            const nextState = NumericInput.getDerivedStateFromProps(
                { max: INVERTED_MAX, min: INVERTED_MIN, minorStepSize: 0.1, stepSize: 1, value: SUPPLIED_VALUE },
                {
                    currentImeInputInvalid: false,
                    prevMaxProp: 200,
                    prevMinProp: 0,
                    shouldSelectAfterUpdate: false,
                    stepMaxPrecision: 1,
                    value: String(SUPPLIED_VALUE),
                },
            );

            expect(nextState.value).toBe(String(SUPPLIED_VALUE));
        });

        it("derives state for an inverted range on the first mount without throwing", () => {
            const nextState = NumericInput.getDerivedStateFromProps(
                { max: INVERTED_MAX, min: INVERTED_MIN, minorStepSize: 0.1, stepSize: 1, value: 0 },
                {
                    currentImeInputInvalid: false,
                    shouldSelectAfterUpdate: false,
                    stepMaxPrecision: 1,
                    value: "0",
                },
            );

            expect(nextState.value).toBe("0");
        });

        it("keeps a localized value when min is greater than max", () => {
            render(<NumericInput locale="de-DE" min={INVERTED_MIN} max={INVERTED_MAX} value={SUPPLIED_VALUE} />);
            expectSuppliedValue();
        });
    });

    describe("user-edited range endpoints", () => {
        function RangeScreen() {
            const [min, setMin] = useState(0);
            const [max, setMax] = useState(10);

            return (
                <section>
                    <H1>Invoices</H1>
                    <label>
                        From
                        <input
                            aria-label="from"
                            value={String(min)}
                            onChange={event => setMin(Number(event.target.value))}
                        />
                    </label>
                    <label>
                        To
                        <input
                            aria-label="to"
                            value={String(max)}
                            onChange={event => setMax(Number(event.target.value))}
                        />
                    </label>
                    <NumericInput aria-label="amount" min={min} max={max} value={4} />
                </section>
            );
        }

        it("keeps the screen mounted when a user sets the lower endpoint above the upper endpoint", async () => {
            const user = userEvent.setup();
            render(<RangeScreen />);

            expect(screen.getByRole("heading", { name: "Invoices" })).toBeInTheDocument();
            expect(screen.getByRole("spinbutton", { name: "amount" })).toHaveValue("4");

            const from = screen.getByRole("textbox", { name: "from" });
            await user.clear(from);
            await user.type(from, "20");

            expect(screen.getByRole("heading", { name: "Invoices" })).toBeInTheDocument();
            expect(screen.getByRole("spinbutton", { name: "amount" })).toHaveValue("4");
            expect(from).toHaveValue("20");
        });
    });

    describe("stepping and blur", () => {
        it("increments an empty field when min is greater than max", async () => {
            const user = userEvent.setup();
            render(<NumericInput min={INVERTED_MIN} max={INVERTED_MAX} />);

            await user.click(screen.getByRole("button", { name: "increment" }));

            // Empty fields step from 0. The step must not be replaced by either inverted bound.
            expect(screen.getByRole("spinbutton")).toHaveValue("1");
        });

        it("decrements an empty field when min is greater than max", async () => {
            const user = userEvent.setup();
            render(<NumericInput min={INVERTED_MIN} max={INVERTED_MAX} />);

            await user.click(screen.getByRole("button", { name: "decrement" }));

            expect(screen.getByRole("spinbutton")).toHaveValue("-1");
        });

        it("applies the major step when min is greater than max", async () => {
            const user = userEvent.setup();
            render(<NumericInput min={3} max={1} />);

            await user.keyboard("{Shift>}");
            await user.click(screen.getByRole("button", { name: "increment" }));
            await user.keyboard("{/Shift}");

            expect(screen.getByRole("spinbutton")).toHaveValue("10");
        });

        it("applies the minor step when min is greater than max", async () => {
            const user = userEvent.setup();
            render(<NumericInput min={3} max={1} />);

            await user.keyboard("{Alt>}");
            await user.click(screen.getByRole("button", { name: "increment" }));
            await user.keyboard("{/Alt}");

            expect(screen.getByRole("spinbutton")).toHaveValue("0.1");
        });

        it("steps with the arrow keys when min is greater than max", async () => {
            const user = userEvent.setup();
            const onValueChange = vi.fn();
            render(<NumericInput min={3} max={1} onValueChange={onValueChange} />);
            const input = screen.getByRole("spinbutton");

            await user.type(input, "8{ArrowUp}");

            expect(onValueChange).toHaveBeenLastCalledWith(9, "9", input);
            expect(input).toHaveValue("9");
        });

        it("steps down with the arrow keys when min is greater than max", async () => {
            const user = userEvent.setup();
            const onValueChange = vi.fn();
            render(<NumericInput min={3} max={1} onValueChange={onValueChange} />);
            const input = screen.getByRole("spinbutton");

            await user.type(input, "8{ArrowDown}");

            expect(onValueChange).toHaveBeenLastCalledWith(7, "7", input);
            expect(input).toHaveValue("7");
        });

        it("leaves a blurred value in place when clampValueOnBlur is set and min is greater than max", () => {
            const onValueChange = vi.fn();
            render(
                <section>
                    <H1>Invoices</H1>
                    <NumericInput
                        clampValueOnBlur={true}
                        min={INVERTED_MIN}
                        max={INVERTED_MAX}
                        onValueChange={onValueChange}
                    />
                </section>,
            );
            const input = screen.getByRole("spinbutton") as HTMLInputElement;

            // Set the DOM value without a change event so blur is the operation under test.
            input.value = "8";
            fireEvent.blur(input);

            expect(onValueChange).toHaveBeenCalledWith(8, "8", input);
            expect(screen.getByRole("heading", { name: "Invoices" })).toBeInTheDocument();
            expect(input).toHaveValue("8");
        });

        it("reports the unclamped stepped value when min is greater than max", async () => {
            const user = userEvent.setup();
            const onValueChange = vi.fn();
            render(<NumericInput min={INVERTED_MIN} max={INVERTED_MAX} onValueChange={onValueChange} />);

            await user.click(screen.getByRole("button", { name: "decrement" }));

            expect(onValueChange).toHaveBeenCalledWith(-1, "-1", expect.anything());
        });
    });
});
