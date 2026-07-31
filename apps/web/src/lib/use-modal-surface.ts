import { useEffect, type RefObject } from "react";

// Matches the drawer transitions in styles.css.
const DRAWER_TRANSITION_MS = 220;

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) =>
      !element.hasAttribute("hidden") &&
      // Not offsetParent: it is null for everything inside a position: fixed
      // element, which is exactly what these drawers are once they overlay
      // the conversation.
      element.getClientRects().length > 0,
  );
}

/**
 * Keyboard behaviour for a surface that visually covers the conversation:
 * Escape closes it, Tab cycles inside it, the rest of the shell is inert
 * while it is open, and focus returns where it came from on close.
 *
 * Without this the drawers were reachable only by tabbing backwards, and Tab
 * moved forward into content sitting behind the scrim — dimmed and
 * pointer-blocked, so keyboard users could operate controls mouse users
 * could not.
 */
export function useModalSurface(options: {
  open: boolean;
  surface: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Skip when the surface is laid out inline rather than over the content. */
  enabled?: boolean;
}): void {
  const { open, surface, onClose, enabled = true } = options;
  const active = open && enabled;

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const container = surface.current;
      if (!container) return;
      const focusable = focusableWithin(container);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      const activeElement = document.activeElement;
      if (!container.contains(activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, onClose, surface]);

  useEffect(() => {
    if (!active) return;
    const container = surface.current;
    const restoreFocusTo =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    // Everything in the shell except the surface itself. The settings dialog
    // is excluded too: it owns its own inerting and may open above a drawer.
    const background = [
      ...document.querySelectorAll<HTMLElement>(".app-shell > *"),
    ].filter(
      (element) =>
        element !== container &&
        !element.contains(container) &&
        !element.classList.contains("settings-backdrop"),
    );
    const priorState = new Map(
      background.map((element) => [
        element,
        {
          ariaHidden: element.getAttribute("aria-hidden"),
          inert: element.hasAttribute("inert"),
        },
      ]),
    );
    for (const element of background) {
      element.setAttribute("inert", "");
      element.setAttribute("aria-hidden", "true");
    }
    // These drawers slide in, and focus() is silently ignored while the
    // element is still transitioning into visibility. Try immediately, then
    // once more after the transition would have finished.
    const focusFirst = () => {
      if (!container || container.contains(document.activeElement)) return;
      focusableWithin(container)[0]?.focus();
    };
    const frame = window.requestAnimationFrame(focusFirst);
    const settled = window.setTimeout(focusFirst, DRAWER_TRANSITION_MS + 40);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settled);
      for (const element of background) {
        const previous = priorState.get(element);
        if (!previous?.inert) element.removeAttribute("inert");
        if (previous?.ariaHidden == null) {
          element.removeAttribute("aria-hidden");
        } else {
          element.setAttribute("aria-hidden", previous.ariaHidden);
        }
      }
      if (restoreFocusTo?.isConnected) restoreFocusTo.focus();
    };
  }, [active, surface]);
}
