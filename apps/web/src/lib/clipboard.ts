function refocus(element: Element | null): void {
  const focusable = element as { focus?: () => void } | null;
  if (typeof focusable?.focus === "function") focusable.focus();
}

function copyWithCommand(value: string): boolean {
  const previouslyFocused = document.activeElement;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  // readonly suppresses the on-screen keyboard; the offsets keep the element
  // inside the viewport, which position: fixed alone does not guarantee.
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  try {
    document.body.append(textarea);
    textarea.select();
    // WebKit ignores select() on a readonly textarea, leaving the document
    // selection empty and the copy command a silent no-op.
    textarea.setSelectionRange(0, value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    refocus(previouslyFocused);
  }
}

export async function copyText(value: string): Promise<boolean> {
  // navigator.clipboard only exists in secure contexts; plain-HTTP LAN access
  // during network development must fall back to the legacy copy command.
  // That fallback runs synchronously here, preserving the user gesture WebKit
  // requires. A rejected writeText resumes after an await and has already lost
  // the gesture on WebKit, so the retry below is best-effort for other engines.
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall through to the legacy path.
    }
  }
  return copyWithCommand(value);
}
