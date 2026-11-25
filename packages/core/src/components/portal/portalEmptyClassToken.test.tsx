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

/* eslint-disable @typescript-eslint/no-deprecated -- legacy Overlay and Popover still forward portal class names */

/**
 * Spec for portal class strings that contain empty tokens from a leading,
 * trailing, or repeated space. The portal must still attach its children, and
 * updating or unmounting that class string must not throw.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps, useState } from "react";

import { afterEach, beforeEach, describe, expect, it, vi } from "@blueprintjs/test-commons/vitest";

import { Classes } from "../../common";
import { BlueprintProvider } from "../../context/blueprintProvider";
import { PortalProvider } from "../../context/portal/portalProvider";
import { Alert } from "../alert/alert";
import { Button } from "../button/buttons";
import { Dialog } from "../dialog/dialog";
import { Drawer } from "../drawer/drawer";
import { Menu } from "../menu/menu";
import { MenuItem } from "../menu/menuItem";
import { Overlay } from "../overlay/overlay";
import { Overlay2 } from "../overlay2/overlay2";
import { Popover } from "../popover/popover";
import { PopoverNext } from "../popover-next/popoverNext";
import { OverlayToaster } from "../toast/overlayToaster";
import { Toast } from "../toast/toast";
import { Tooltip } from "../tooltip/tooltip";

import { Portal } from "./portal";

const EMPTY_TOKEN = "must not be empty";

describe("portal class names with empty tokens", () => {
    const tokenErrors: string[] = [];
    let consoleError: { mockRestore(): void } | undefined;

    beforeEach(() => {
        tokenErrors.length = 0;
        window.addEventListener("error", recordWindowError);
        consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
            recordTokenError(args.map(formatError).join(" "));
        });
    });

    afterEach(() => {
        cleanup();
        window.removeEventListener("error", recordWindowError);
        consoleError?.mockRestore();
        expect(tokenErrors).toEqual([]);
    });

    function recordWindowError(event: ErrorEvent) {
        recordTokenError(formatError(event.error ?? event.message));
    }

    function recordTokenError(text: string) {
        if (text.includes(EMPTY_TOKEN) || text.includes("SyntaxError")) {
            tokenErrors.push(text);
        }
    }

    describe("Portal className", () => {
        it.each([
            ["a leading space", " marker", ["marker"]],
            ["a trailing space", "marker ", ["marker"]],
            ["a repeated space", "marker  extra", ["marker", "extra"]],
            ["leading, trailing, and repeated spaces", " marker  extra ", ["marker", "extra"]],
        ])("attaches children for a class string with %s", (_label, className, tokens) => {
            render(
                <Portal className={className}>
                    <p>portal body</p>
                </Portal>,
            );

            expect(classTokensOf("portal body")).toEqual([Classes.PORTAL, ...tokens]);
        });

        it("treats a whitespace-only class string as no extra class", () => {
            render(
                <Portal className={"   "}>
                    <p>portal body</p>
                </Portal>,
            );

            expect(classTokensOf("portal body")).toEqual([Classes.PORTAL]);
        });

        it("keeps children attached when a spaced class string replaces another", () => {
            const { rerender } = render(
                <Portal className="alpha  beta">
                    <p>portal body</p>
                </Portal>,
            );

            expect(classTokensOf("portal body")).toEqual([Classes.PORTAL, "alpha", "beta"]);

            rerender(
                <Portal className={" gamma "}>
                    <p>portal body</p>
                </Portal>,
            );

            expect(screen.getByText("portal body")).toBeInTheDocument();
            expect(classTokensOf("portal body")).toEqual([Classes.PORTAL, "gamma"]);
            expect(document.querySelectorAll(`.${Classes.PORTAL}`)).toHaveLength(1);
        });

        it("removes a spaced class string without leaving the portal attached", () => {
            const { rerender, unmount } = render(
                <Portal className="alpha  beta">
                    <p>portal body</p>
                </Portal>,
            );

            expect(classTokensOf("portal body")).toEqual([Classes.PORTAL, "alpha", "beta"]);

            rerender(
                <Portal>
                    <p>portal body</p>
                </Portal>,
            );

            expect(classTokensOf("portal body")).toEqual([Classes.PORTAL]);

            unmount();

            expect(document.querySelector(`.${Classes.PORTAL}`)).not.toBeInTheDocument();
            expect(screen.queryByText("portal body")).not.toBeInTheDocument();
        });

        it("attaches a spaced class into the requested container only", () => {
            const container = document.createElement("div");
            document.body.appendChild(container);

            render(
                <Portal className={" marker  extra "} container={container}>
                    <p>contained body</p>
                </Portal>,
            );

            const portal = portalHosting("contained body");
            expect(container.contains(portal)).toBe(true);
            expect(classTokensOf("contained body")).toEqual([Classes.PORTAL, "marker", "extra"]);
            expect(document.body.querySelectorAll(`:scope > .${Classes.PORTAL}`)).toHaveLength(0);

            container.remove();
        });
    });

    describe("provider portalClassName", () => {
        it("applies spaced classes from both the portal and its provider", () => {
            render(
                <PortalProvider portalClassName={" from-provider "}>
                    <Portal className="from-prop  second">
                        <p>portal body</p>
                    </Portal>
                </PortalProvider>,
            );

            expect(classTokensOf("portal body")).toEqual([Classes.PORTAL, "from-prop", "second", "from-provider"]);
        });

        it("keeps children attached when the provider class gains empty tokens", () => {
            const { rerender } = render(
                <PortalProvider portalClassName="steady">
                    <Portal>
                        <p>portal body</p>
                    </Portal>
                </PortalProvider>,
            );

            expect(classTokensOf("portal body")).toEqual([Classes.PORTAL, "steady"]);

            rerender(
                <PortalProvider portalClassName={" steady  fresh "}>
                    <Portal>
                        <p>portal body</p>
                    </Portal>
                </PortalProvider>,
            );

            expect(classTokensOf("portal body")).toEqual([Classes.PORTAL, "steady", "fresh"]);
            expect(document.querySelectorAll(`.${Classes.PORTAL}`)).toHaveLength(1);
        });

        it("mounts every portaled overlay under one spaced BlueprintProvider class", () => {
            render(
                <BlueprintProvider portalClassName={" app-theme "}>
                    <Portal>
                        <p>first overlay</p>
                    </Portal>
                    <Portal>
                        <p>second overlay</p>
                    </Portal>
                </BlueprintProvider>,
            );

            expect(classTokensOf("first overlay")).toEqual([Classes.PORTAL, "app-theme"]);
            expect(classTokensOf("second overlay")).toEqual([Classes.PORTAL, "app-theme"]);
        });
    });

    describe("overlays that portal their content", () => {
        it("shows a legacy overlay whose portal class has empty tokens", () => {
            render(
                <Overlay isOpen={true} transitionDuration={0} portalClassName={" legacy  overlay "}>
                    <p>legacy overlay body</p>
                </Overlay>,
            );

            expect(classTokensOf("legacy overlay body")).toEqual([Classes.PORTAL, "legacy", "overlay"]);
        });

        it("shows an Overlay2 whose portal class has empty tokens", () => {
            render(
                <Overlay2 isOpen={true} transitionDuration={0} portalClassName={" overlay  two "}>
                    <span>overlay2 body</span>
                </Overlay2>,
            );

            expect(classTokensOf("overlay2 body")).toEqual([Classes.PORTAL, "overlay", "two"]);
        });

        it("shows a drawer whose portal class has empty tokens", () => {
            render(
                <Drawer isOpen={true} transitionDuration={0} portalClassName={" drawer  root "} title="Drawer">
                    <p>drawer body</p>
                </Drawer>,
            );

            expect(classTokensOf("drawer body")).toEqual([Classes.PORTAL, "drawer", "root"]);
        });

        it("lets the user confirm a dialog whose portal class has empty tokens", async () => {
            const user = userEvent.setup();
            const onConfirm = vi.fn();

            render(
                <Dialog
                    isOpen={true}
                    transitionDuration={0}
                    title="Delete item"
                    portalClassName={" dialog  portal "}
                    onClose={vi.fn()}
                >
                    <Button text="Confirm delete" onClick={onConfirm} />
                </Dialog>,
            );

            expect(classTokensOf("Confirm delete")).toEqual([Classes.PORTAL, "dialog", "portal"]);
            await user.click(screen.getByRole("button", { name: "Confirm delete" }));
            expect(onConfirm).toHaveBeenCalledOnce();
        });

        it("lets the user confirm an alert when the provider class has empty tokens", async () => {
            const user = userEvent.setup();
            const onConfirm = vi.fn();

            render(
                <BlueprintProvider portalClassName={" app-theme "}>
                    <Alert
                        // Alert's public type omits portalClassName. The component still forwards
                        // remaining props to Dialog, and Dialog passes them through to the portal.
                        {...({ portalClassName: " alert  portal " } as unknown as ComponentProps<typeof Alert>)}
                        isOpen={true}
                        transitionDuration={0}
                        confirmButtonText="Confirm"
                        onConfirm={onConfirm}
                    >
                        Delete this item?
                    </Alert>
                </BlueprintProvider>,
            );

            expect(screen.getByRole("alertdialog")).toBeInTheDocument();
            expect(classTokensOf("Delete this item?")).toEqual([Classes.PORTAL, "alert", "portal", "app-theme"]);
            await user.click(screen.getByRole("button", { name: "Confirm" }));
            expect(onConfirm).toHaveBeenCalledOnce();
        });

        it("shows popover content whose portal class has empty tokens", async () => {
            render(
                <Popover
                    isOpen={true}
                    transitionDuration={0}
                    content="popover content"
                    portalClassName={" popover  portal "}
                >
                    <Button text="popover target" />
                </Popover>,
            );

            await waitFor(() => expect(screen.getByText("popover content")).toBeInTheDocument());
            expect(classTokensOf("popover content")).toEqual([Classes.PORTAL, "popover", "portal"]);
        });

        it("shows PopoverNext content whose portal class has empty tokens", async () => {
            render(
                <PopoverNext
                    isOpen={true}
                    transitionDuration={0}
                    content="next popover content"
                    portalClassName={" next  portal "}
                >
                    <Button text="next target" />
                </PopoverNext>,
            );

            await waitFor(() => expect(screen.getByText("next popover content")).toBeInTheDocument());
            expect(classTokensOf("next popover content")).toEqual([Classes.PORTAL, "next", "portal"]);
        });

        it("shows a tooltip whose portal class has empty tokens", async () => {
            render(
                <Tooltip
                    isOpen={true}
                    content="tooltip content"
                    hoverOpenDelay={0}
                    transitionDuration={0}
                    portalClassName={" tip  portal "}
                >
                    <Button text="tooltip target" />
                </Tooltip>,
            );

            await waitFor(() => expect(screen.getByText("tooltip content")).toBeInTheDocument());
            expect(classTokensOf("tooltip content")).toEqual([Classes.PORTAL, "tip", "portal"]);
        });

        it("shows a menu portaled under a provider class with empty tokens", async () => {
            render(
                <BlueprintProvider portalClassName={" menu  theme "}>
                    <Popover
                        isOpen={true}
                        transitionDuration={0}
                        content={
                            <Menu>
                                <MenuItem text="Rename" />
                            </Menu>
                        }
                    >
                        <Button text="menu target" />
                    </Popover>
                </BlueprintProvider>,
            );

            await waitFor(() => expect(screen.getByRole("menuitem", { name: "Rename" })).toBeInTheDocument());
            expect(classTokensOf("Rename")).toEqual([Classes.PORTAL, "menu", "theme"]);
        });

        it("shows a toast portaled under a provider class with empty tokens", () => {
            render(
                <BlueprintProvider portalClassName={" toast  theme "}>
                    <OverlayToaster>
                        <Toast message="Saved changes" timeout={0} />
                    </OverlayToaster>
                </BlueprintProvider>,
            );

            expect(screen.getByRole("alert")).toHaveTextContent("Saved changes");
            expect(classTokensOf("Saved changes")).toEqual([Classes.PORTAL, "toast", "theme"]);
        });

        it("still shows an overlay after the spaced class is edited", async () => {
            const user = userEvent.setup();
            const onConfirm = vi.fn();

            render(<EditablePortalClass onConfirm={onConfirm} />);

            await user.click(screen.getByRole("button", { name: "Confirm delete" }));
            expect(onConfirm).toHaveBeenCalledOnce();

            await user.click(screen.getByRole("button", { name: "Change class" }));

            expect(screen.getByRole("button", { name: "Confirm delete" })).toBeInTheDocument();
            expect(classTokensOf("Confirm delete")).toEqual([Classes.PORTAL, "edited", "portal"]);
            expect(document.querySelectorAll(`.${Classes.PORTAL}`)).toHaveLength(1);
        });
    });
});

function EditablePortalClass({ onConfirm }: { onConfirm: () => void }) {
    const [portalClassName, setPortalClassName] = useState(" confirm  dialog ");
    return (
        <>
            <Button text="Change class" onClick={() => setPortalClassName(" edited  portal ")} />
            <Dialog
                isOpen={true}
                transitionDuration={0}
                title="Delete item"
                portalClassName={portalClassName}
                onClose={vi.fn()}
            >
                <Button text="Confirm delete" onClick={onConfirm} />
            </Dialog>
        </>
    );
}

function portalHosting(text: string): HTMLElement {
    const portal = screen.getByText(text).closest(`.${Classes.PORTAL}`);
    expect(portal).toBeInstanceOf(HTMLElement);
    expect(document.body.contains(portal)).toBe(true);
    return portal as HTMLElement;
}

function classTokensOf(text: string): string[] {
    return [...portalHosting(text).classList];
}

function formatError(value: unknown): string {
    if (value instanceof Error) {
        return `${value.name} ${value.message}`;
    }
    return String(value);
}
