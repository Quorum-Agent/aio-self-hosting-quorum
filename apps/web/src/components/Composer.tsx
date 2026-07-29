import { ArrowUp, Mic, Paperclip, Square } from "lucide-react";
import { type KeyboardEvent, useRef } from "react";

interface ComposerProps {
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
}

export function Composer({
  value,
  busy,
  onChange,
  onSend,
  onStop,
}: ComposerProps) {
  const textarea = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!busy && value.trim()) onSend();
    }
  };

  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={textarea}
          rows={1}
          value={value}
          aria-label="Message Quorum"
          placeholder="Ask anything. Quorum routes it privately."
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="composer-actions">
          <div>
            <button className="icon-button" type="button" aria-label="Attach a file">
              <Paperclip size={18} />
            </button>
            <button className="icon-button" type="button" aria-label="Use voice input">
              <Mic size={18} />
            </button>
          </div>
          <button
            className={`send-button ${busy ? "is-stop" : ""}`}
            type="button"
            disabled={!busy && !value.trim()}
            onClick={busy ? onStop : onSend}
            aria-label={busy ? "Stop generating" : "Send message"}
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
