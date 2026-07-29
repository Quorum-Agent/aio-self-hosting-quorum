import { ArrowUp, Square } from "lucide-react";
import { type KeyboardEvent, useRef } from "react";

interface ComposerProps {
  value: string;
  busy: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
}

export function Composer({
  value,
  busy,
  disabled = false,
  disabledReason = "Preparing local models…",
  onChange,
  onSend,
  onStop,
}: ComposerProps) {
  const textarea = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
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
              : "Ask anything. Quorum routes it privately."
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
        Local by default <span>·</span> You control when data leaves this device
      </p>
    </div>
  );
}
