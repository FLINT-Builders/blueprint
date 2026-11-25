/*
 * Copyright 2026 Palantir Technologies, Inc. All rights reserved.
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
import { Component, type ReactNode, useState } from "react";

import { describe, expect, it, vi } from "@blueprintjs/test-commons/vitest";

import { NumericInput, type NumericInputProps } from "./numericInput";

/**
 * Locale tags an application can store and pass through. Underscores, spaces, and
 * other non-BCP-47 strings are rejected by Intl with RangeError.
 */
const INVALID_LOCALES = ["en_US", "en US", "not a locale", ""] as const;

class LocaleRenderBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
    public state: { error: Error | null } = { error: null };

    public static getDerivedStateFromError(error: Error) {
        return { error };
    }

    public render() {
        if (this.state.error != null) {
            return <div data-testid="locale-render-error">{this.state.error.name}</div>;
        }
        return this.props.children;
    }
}

function renderField(ui: React.ReactElement) {
    return render(<LocaleRenderBoundary>{ui}</LocaleRenderBoundary>);
}

/** The numeric control must stay mounted. An error-boundary fallback means formatting threw during render. */
function expectFieldMounted(value?: string) {
    expect(screen.queryByTestId("locale-render-error")).not.toBeInTheDocument();
    const input = screen.getByRole("spinbutton");
    if (value !== undefined) {
        expect(input).toHaveValue(value);
    }
    return input;
}

function ControlledNumericInput(props: NumericInputProps) {
    const [value, setValue] = useState(props.value?.toString() ?? "");
    return (
        <NumericInput
            {...props}
            value={value}
            onValueChange={(valueAsNumber, valueAsString, inputElement) => {
                setValue(valueAsString);
                props.onValueChange?.(valueAsNumber, valueAsString, inputElement);
            }}
        />
    );
}

describe("NumericInput locale", () => {
    describe("invalid locale tags", () => {
        it.each(INVALID_LOCALES)("keeps a populated controlled field mounted when locale is %j", locale => {
            renderField(<NumericInput locale={locale} value="42" />);
            expectFieldMounted("42");
        });

        it.each(INVALID_LOCALES)("keeps a populated uncontrolled field mounted when locale is %j", locale => {
            renderField(<NumericInput defaultValue={42} locale={locale} />);
            expectFieldMounted("42");
        });

        it.each(INVALID_LOCALES)("keeps an empty controlled field mounted when locale is %j", locale => {
            renderField(<NumericInput locale={locale} value="" />);
            expectFieldMounted("");
        });

        it.each(INVALID_LOCALES)("keeps an empty uncontrolled field mounted when locale is %j", locale => {
            renderField(<NumericInput locale={locale} />);
            expectFieldMounted("");
        });

        it("keeps the field mounted when a valid locale changes to an invalid one", () => {
            const { rerender } = renderField(<NumericInput locale="en-US" value="10" />);
            expectFieldMounted("10");

            rerender(
                <LocaleRenderBoundary>
                    <NumericInput locale="en_US" value="10" />
                </LocaleRenderBoundary>,
            );

            expectFieldMounted("10");
        });

        it("still shows the field when buttons are not rendered", () => {
            renderField(<NumericInput buttonPosition="none" locale="en_US" value="7" />);
            expectFieldMounted("7");
        });
    });

    describe("editing after an invalid locale", () => {
        it("accepts digits and rejects letters and character-class metacharacters", async () => {
            const user = userEvent.setup();
            const onValueChange = vi.fn();
            renderField(<ControlledNumericInput locale="en_US" onValueChange={onValueChange} value="" />);
            const input = expectFieldMounted("");

            // `[[` is the user-event escape for a literal "[". The typed text is 12a3[]\.
            await user.type(input, "12a3[[]\\]");

            expectFieldMounted("123");
            expect(onValueChange).toHaveBeenLastCalledWith(123, "123", expect.anything());
        });

        it("strips non-numeric characters from a paste", () => {
            const onValueChange = vi.fn();
            renderField(<ControlledNumericInput locale="en US" onValueChange={onValueChange} value="" />);
            const input = expectFieldMounted("");

            fireEvent.paste(input);
            fireEvent.change(input, { target: { value: "12a3[]\\" } });

            expectFieldMounted("123");
            expect(onValueChange).toHaveBeenLastCalledWith(123, "123", expect.anything());
        });

        it("does not throw while an IME composition is sanitized", () => {
            const onValueChange = vi.fn();
            renderField(<ControlledNumericInput locale="not a locale" onValueChange={onValueChange} value="5" />);
            const input = expectFieldMounted("5");

            fireEvent.compositionUpdate(input, { data: "a[" });
            expectFieldMounted("5");

            fireEvent.compositionEnd(input, { data: "a[" });

            expect(screen.queryByTestId("locale-render-error")).not.toBeInTheDocument();
            expect(onValueChange).toHaveBeenLastCalledWith(0, "", expect.anything());
            expect(input).toHaveValue("");
        });

        it("increments and decrements without throwing", async () => {
            const user = userEvent.setup();
            const onValueChange = vi.fn();
            renderField(<ControlledNumericInput locale="en_US" onValueChange={onValueChange} value="5" />);
            expectFieldMounted("5");

            await user.click(screen.getByRole("button", { name: "increment" }));
            expectFieldMounted("6");
            expect(onValueChange).toHaveBeenLastCalledWith(6, "6", expect.anything());

            await user.click(screen.getByRole("button", { name: "decrement" }));
            expectFieldMounted("5");
            expect(onValueChange).toHaveBeenLastCalledWith(5, "5", expect.anything());
        });

        it("increments from the keyboard without throwing", async () => {
            const user = userEvent.setup();
            renderField(<ControlledNumericInput locale="en_US" value="5" />);
            const input = expectFieldMounted("5");

            await user.type(input, "{ArrowUp}");

            expectFieldMounted("6");
        });

        it("rounds on blur without throwing", () => {
            // Precision comes from stepSize when minorStepSize is null. Mount keeps the raw text;
            // blur is what rounds it. Max is omitted so mount does not clamp before blur.
            renderField(
                <ControlledNumericInput
                    clampValueOnBlur={true}
                    locale="en_US"
                    minorStepSize={null}
                    stepSize={1}
                    value="9.6"
                />,
            );
            const input = expectFieldMounted("9.6");

            fireEvent.blur(input);

            expectFieldMounted("10");
        });
    });
});
