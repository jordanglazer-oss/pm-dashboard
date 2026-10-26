"use client";

import React from "react";
import { DropdownMenu } from "radix-ui";

/**
 * Dropdown menu built on Radix (keyboard navigation, Esc / outside-click to
 * close, focus return, collision-aware placement), styled with the workspace
 * tokens. Styling lives in globals.css under `.ui-menu*`.
 */
export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;

export function MenuContent({ children, align = "end", className = "" }: { children: React.ReactNode; align?: "start" | "center" | "end"; className?: string }) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content align={align} sideOffset={6} collisionPadding={8} className={`ui-menu ${className}`}>
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

/**
 * One menu row. `keepOpen` leaves the menu open after the click, for actions
 * whose result shows on the row itself ("Copied!", a spinner).
 */
export function MenuItem({
  children, onSelect, disabled, keepOpen, title, icon, danger,
}: {
  children: React.ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  keepOpen?: boolean;
  title?: string;
  icon?: React.ReactNode;
  /** Destructive action — rendered in the negative tone. */
  danger?: boolean;
}) {
  return (
    <DropdownMenu.Item
      className={`ui-menu-item ${danger ? "ui-menu-item-danger" : ""}`}
      disabled={disabled}
      title={title}
      onSelect={(e) => {
        if (keepOpen) e.preventDefault();
        onSelect?.();
      }}
    >
      {icon && <span className="ui-menu-icon">{icon}</span>}
      <span className="min-w-0 flex-1">{children}</span>
    </DropdownMenu.Item>
  );
}

export function MenuLabel({ children }: { children: React.ReactNode }) {
  return <DropdownMenu.Label className="ui-menu-label">{children}</DropdownMenu.Label>;
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="ui-menu-sep" />;
}
