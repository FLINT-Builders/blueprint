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
import { useContext, useMemo, useState } from "react";

import { describe, expect, it, vi } from "@blueprintjs/test-commons/vitest";

import { HotkeysContext, HotkeysProvider } from "../../context";
import { useHotkeys } from "../../hooks";

import { Hotkey } from "./hotkey";
import { getKeyCombo, getKeyComboString, MODIFIER_BIT_MASKS, normalizeKeyCombo, parseKeyCombo } from "./hotkeyParser";
import { HotkeysDialog } from "./hotkeysDialog";
import { HotkeysTarget } from "./hotkeysTarget";
import { KeyComboTagInternal } from "./keyComboTag";

/**
 * Names of properties on Object.prototype. A plain object lookup of any of these
 * returns an inherited function or object, not a configured alias.
 *
 * parseKeyCombo lowercases each piece before the lookup, so only the names that
 * are already fully lowercase still hit the prototype there. normalizeKeyCombo,
 * getKeyCombo, and getKeyComboString look the name up with its original casing.
 */
const INHERITED_PROPERTY_NAMES = [
    "constructor",
    "__proto__",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
] as const;

const LOWERCASED_INHERITED_NAMES = ["constructor", "__proto__"] as const;

function assertStringList(keys: readonly unknown[], expected: readonly string[]) {
    expect(keys).to.deep.equal(expected);
    for (const key of keys) {
        expect(typeof key).to.equal("string");
    }
}

describe("inherited property names in hotkey parsing", () => {
    describe("parseKeyCombo", () => {
        it.each(LOWERCASED_INHERITED_NAMES)("treats %s as a plain key", piece => {
            const parsed = parseKeyCombo(piece);

            expect(parsed).to.deep.equal({ key: piece, modifiers: 0 });
            expect(typeof parsed.key).to.equal("string");
            expect(Number.isInteger(parsed.modifiers)).to.equal(true);
        });

        it.each(LOWERCASED_INHERITED_NAMES)("treats an uppercase %s piece as that plain key", piece => {
            const parsed = parseKeyCombo(` ${piece.toUpperCase()} `);

            expect(parsed).to.deep.equal({ key: piece, modifiers: 0 });
            expect(typeof parsed.key).to.equal("string");
        });

        it.each(LOWERCASED_INHERITED_NAMES)("keeps real modifiers when %s is the action key", piece => {
            const parsed = parseKeyCombo(`ctrl + shift + ${piece}`);

            expect(parsed).to.deep.equal({
                key: piece,
                modifiers: MODIFIER_BIT_MASKS.ctrl + MODIFIER_BIT_MASKS.shift,
            });
            expect(typeof parsed.key).to.equal("string");
            expect(Number.isInteger(parsed.modifiers)).to.equal(true);
        });

        it("still resolves configured aliases", () => {
            expect(parseKeyCombo("return")).to.deep.equal({ key: "enter", modifiers: 0 });
            expect(parseKeyCombo("esc")).to.deep.equal({ key: "escape", modifiers: 0 });
        });
    });

    describe("normalizeKeyCombo", () => {
        it.each(INHERITED_PROPERTY_NAMES)("does not resolve inherited name %s", name => {
            assertStringList(normalizeKeyCombo(name, "Win32"), [name]);
            assertStringList(normalizeKeyCombo(`meta + ${name}`, "Win32"), ["ctrl", name]);
            assertStringList(normalizeKeyCombo(`meta + ${name}`, "Mac"), ["cmd", name]);
        });

        it("still resolves configured aliases", () => {
            assertStringList(normalizeKeyCombo("return + up", "linux"), ["enter", "ArrowUp"]);
        });
    });

    describe("keyboard event lookup", () => {
        it.each(INHERITED_PROPERTY_NAMES)("does not map shift + %s through the prototype", name => {
            const event = { code: "", key: name, shiftKey: true } as KeyboardEvent;
            const combo = getKeyCombo(event);

            expect(combo.key).to.equal(name.toLowerCase());
            expect(typeof combo.key).to.equal("string");
            expect(combo.modifiers).to.equal(MODIFIER_BIT_MASKS.shift);
            expect(getKeyComboString(event)).to.equal(`shift + ${name.toLowerCase()}`);
        });
    });

    describe("KeyComboTag", () => {
        it.each(LOWERCASED_INHERITED_NAMES)("renders %s without throwing", piece => {
            render(<KeyComboTagInternal combo={piece} platformOverride="Win32" />);

            expect(screen.getByText(piece)).toBeInTheDocument();
        });

        it.each(INHERITED_PROPERTY_NAMES)("renders minimal and full labels for %s", name => {
            const { unmount } = render(
                <KeyComboTagInternal combo={`shift + ${name}`} minimal={true} platformOverride="Win32" />,
            );

            expect(screen.getByText(`shift + ${name}`, { exact: false })).toBeInTheDocument();
            unmount();

            render(<KeyComboTagInternal combo={`shift + ${name}`} platformOverride="Win32" />);

            expect(screen.getByText("shift")).toBeInTheDocument();
            expect(screen.getByText(name)).toBeInTheDocument();
        });

        it("renders a label that was not registered as a hotkey", () => {
            render(<KeyComboTagInternal combo="ctrl+constructor" platformOverride="Win32" />);

            expect(screen.getByText("ctrl")).toBeInTheDocument();
            expect(screen.getByText("constructor")).toBeInTheDocument();
        });
    });

    describe("Hotkey and HotkeysDialog", () => {
        it.each(LOWERCASED_INHERITED_NAMES)("renders a hotkey row for %s", piece => {
            render(<Hotkey combo={piece} group="custom" label={`Label ${piece}`} />);

            expect(screen.getByText(`Label ${piece}`)).toBeInTheDocument();
            expect(screen.getByText(piece)).toBeInTheDocument();
        });

        it("renders a dialog that lists an inherited shortcut next to a real one", () => {
            render(
                <HotkeysDialog
                    isOpen={true}
                    transitionDuration={0}
                    usePortal={false}
                    hotkeys={[
                        { combo: "constructor", global: true, label: "Custom shortcut" },
                        { combo: "__proto__", global: true, label: "Other shortcut" },
                        { combo: "a", global: true, label: "Real shortcut" },
                    ]}
                />,
            );

            expect(screen.getByText("Custom shortcut")).toBeInTheDocument();
            expect(screen.getByText("constructor")).toBeInTheDocument();
            expect(screen.getByText("Other shortcut")).toBeInTheDocument();
            expect(screen.getByText("__proto__")).toBeInTheDocument();
            expect(screen.getByText("Real shortcut")).toBeInTheDocument();
        });
    });

    describe("useHotkeys and HotkeysTarget", () => {
        it("registers an inherited combo during render and still fires a sibling shortcut", async () => {
            const onRealShortcut = vi.fn();
            const user = userEvent.setup();

            function Shell() {
                const hotkeys = useMemo(
                    () => [
                        { combo: "a", global: true, label: "Real", onKeyDown: onRealShortcut },
                        { combo: "constructor", global: true, label: "Custom", onKeyDown: () => undefined },
                        { combo: "__proto__", group: "local", label: "Local custom", onKeyDown: () => undefined },
                    ],
                    [],
                );
                useHotkeys(hotkeys);
                return <button type="button">shell</button>;
            }

            render(<Shell />);

            expect(screen.getByRole("button", { name: "shell" })).toBeInTheDocument();
            await user.keyboard("a");
            expect(onRealShortcut).toHaveBeenCalledOnce();
        });

        it("keeps the shell mounted when a displayed shortcut changes to an inherited name", async () => {
            function Shell() {
                const [combo, setCombo] = useState("a");
                const hotkeys = useMemo(() => [{ combo, global: true, label: "Custom" }], [combo]);
                useHotkeys(hotkeys);
                return (
                    <div>
                        <button type="button" onClick={() => setCombo("constructor")}>
                            use crafted shortcut
                        </button>
                        <KeyComboTagInternal combo={combo} platformOverride="Win32" />
                    </div>
                );
            }

            const user = userEvent.setup();
            render(<Shell />);
            expect(screen.getByRole("button", { name: "use crafted shortcut" })).toBeInTheDocument();

            await user.click(screen.getByRole("button", { name: "use crafted shortcut" }));

            expect(screen.getByRole("button", { name: "use crafted shortcut" })).toBeInTheDocument();
            expect(screen.getByText("constructor")).toBeInTheDocument();
        });

        it.each(LOWERCASED_INHERITED_NAMES)("renders HotkeysTarget for a local %s shortcut", piece => {
            render(
                <HotkeysTarget hotkeys={[{ combo: piece, group: "custom", label: piece }]}>
                    {() => <div>local target</div>}
                </HotkeysTarget>,
            );

            expect(screen.getByText("local target")).toBeInTheDocument();
        });

        it.each(LOWERCASED_INHERITED_NAMES)("renders HotkeysTarget for a global %s shortcut", piece => {
            render(
                <HotkeysTarget hotkeys={[{ combo: piece, global: true, label: piece }]}>
                    <div>global target</div>
                </HotkeysTarget>,
            );

            expect(screen.getByText("global target")).toBeInTheDocument();
        });

        it("parses an inherited showDialogKeyCombo when a key is pressed", () => {
            function Shell() {
                useHotkeys([{ combo: "a", global: true, label: "Real" }], { showDialogKeyCombo: "constructor" });
                return <div>dialog combo ready</div>;
            }

            render(<Shell />);

            // jsdom reports exceptions from native listeners through the window "error"
            // event instead of rejecting dispatchEvent, so the assertion has to observe that event.
            const listenerErrors: unknown[] = [];
            const onError = (event: ErrorEvent) => {
                listenerErrors.push(event.error ?? event.message);
                event.preventDefault();
            };
            window.addEventListener("error", onError);
            document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, code: "KeyX", key: "x" }));
            window.removeEventListener("error", onError);

            expect(listenerErrors).to.deep.equal([]);
            expect(screen.getByText("dialog combo ready")).toBeInTheDocument();
        });

        it("opens the hotkeys dialog after an inherited shortcut was registered", async () => {
            const user = userEvent.setup();

            function Shell() {
                const [, dispatch] = useContext(HotkeysContext);
                const hotkeys = useMemo(
                    () => [
                        { combo: "a", global: true, label: "Real shortcut" },
                        { combo: "constructor", global: true, label: "Custom shortcut" },
                        { combo: "toString", global: true, label: "Camel shortcut" },
                    ],
                    [],
                );
                useHotkeys(hotkeys);
                return (
                    <button type="button" onClick={() => dispatch({ type: "OPEN_DIALOG" })}>
                        open dialog
                    </button>
                );
            }

            render(
                <HotkeysProvider dialogProps={{ transitionDuration: 0, usePortal: false }}>
                    <Shell />
                </HotkeysProvider>,
            );

            expect(screen.getByRole("button", { name: "open dialog" })).toBeInTheDocument();
            await user.click(screen.getByRole("button", { name: "open dialog" }));

            expect(screen.getByText("Custom shortcut")).toBeInTheDocument();
            expect(screen.getByText("constructor")).toBeInTheDocument();
            expect(screen.getByText("Camel shortcut")).toBeInTheDocument();
            expect(screen.getByText("toString")).toBeInTheDocument();
            expect(screen.getByText("Real shortcut")).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "open dialog" })).toBeInTheDocument();
        });
    });
});
