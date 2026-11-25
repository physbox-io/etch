import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/**
 * Stack of currently open dialogs so nested modals (e.g. DocsModal opened on top
 * of GCodePreviewModal or MachineControlModal) only trap Tab and handle Escape
 * for the topmost dialog.
 */
const dialogStack: Array<RefObject<HTMLElement | null>> = [];

function isVisible(el: HTMLElement): boolean {
  if (el.closest('[hidden],[inert]')) return false;
  const style = window.getComputedStyle(el);
  if (style.visibility === 'hidden' || style.display === 'none') return false;
  return el.offsetParent !== null || style.position === 'fixed';
}

/**
 * Provides modal dialog accessibility: saves and restores focus on open/close,
 * moves initial focus inside the dialog if focus is outside, traps Tab/Shift+Tab
 * for the topmost open dialog, and invokes `onClose` on Escape.
 */
export function useDialogA11y(
  ref: RefObject<HTMLElement | null>,
  isOpen = true,
  onClose?: () => void,
): void {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const prevFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogStack.push(ref);

    const container = ref.current;
    if (container && !container.contains(document.activeElement)) {
      const first = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).find(isVisible);
      if (first) first.focus();
      else {
        if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
        container.focus();
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== ref) return;
      if (!ref.current) return;

      if (e.key === 'Escape') {
        if (onCloseRef.current) {
          e.preventDefault();
          e.stopPropagation();
          onCloseRef.current();
        }
        return;
      }

      if (e.key !== 'Tab') return;
      const nodes = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => isVisible(el) || el === document.activeElement,
      );
      if (nodes.length === 0) {
        e.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !ref.current.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !ref.current.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      const idx = dialogStack.lastIndexOf(ref);
      if (idx !== -1) dialogStack.splice(idx, 1);
      if (prevFocused && prevFocused.isConnected) prevFocused.focus();
    };
  }, [ref, isOpen]);
}
