const DISPLAY_CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f]|\p{Cf}/gu;

/**
 * Make arbitrary text safe to place in the interface.
 *
 * Normalizes to NFKC, removes C0/C1 controls and every Unicode format
 * character — which is what strips the bidirectional overrides that let a
 * hostile string reorder the text around it — collapses whitespace, and bounds
 * the length.
 *
 * It lived inside `orchestrator.ts`, private, until a second caller needed it:
 * the local runtime now reports *why* it cannot serve, and that text comes from
 * a subprocess's log tail. Copying the function would have been the shape this
 * repository keeps finding defects in — one behaviour, two implementations,
 * drifting apart the first time either is edited.
 */
export function safeDisplayText(value: string, maximumLength = 240): string {
  return value
    .normalize("NFKC")
    .replace(DISPLAY_CONTROL_PATTERN, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximumLength);
}
