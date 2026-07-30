import { ArrowUp, Square } from "lucide-react";
import { type KeyboardEvent, useLayoutEffect, useRef } from "react";

interface ComposerProps {
  value: string;
  busy: boolean;
  disabled?: boolean;
  disabledReason?: string;
  networkNotice: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
}

export function Composer({
  value,
  busy,
  disabled = false,
  disabledReason = "Preparing local models…",
  networkNotice,
  onChange,
  onSend,
  onStop,
}: ComposerProps) {
  const textarea = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  }, [value]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!busy && !disabled && value.trim()) onSend();
    }
  };

  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={textarea}
          rows={1}
          value={value}
          disabled={disabled}
          aria-label="Message Quorum"
          placeholder={
            disabled
              ? disabledReason
              : "Ask anything. Quorum shows how it routes."
          }
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="composer-actions">
          <button
            className={`send-button ${busy ? "is-stop" : ""}`}
            type="button"
            disabled={disabled || (!busy && !value.trim())}
            onClick={busy ? onStop : onSend}
            aria-label={
              disabled
                ? disabledReason
                : busy
                  ? "Stop generating"
                  : "Send message"
            }
          >
            {busy ? <Square size={13} fill="currentColor" /> : <ArrowUp size={18} />}
          </button>
        </div>
      </div>
      <p className="composer-note">
        Local by default <span>·</span> {networkNotice}
      </p>
    </div>
  );
}
