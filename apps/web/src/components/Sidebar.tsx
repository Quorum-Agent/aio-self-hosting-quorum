import {
  Download,
  MessageSquare,
  Pencil,
  Plus,
  Settings,
  Sparkles,
  Trash2,
} from "lucide-react";

import type { ConversationRecord } from "../lib/api";

interface SidebarProps {
  conversations: ConversationRecord[];
  activeId: string;
  disabled: boolean;
  onNew: () => void;
  onSelect: (id: string) => void;
  onSettings: () => void;
  onRename: (conversation: ConversationRecord) => void;
  onDelete: (conversation: ConversationRecord) => void;
  onExport: (conversation: ConversationRecord) => void;
}

function relativeTime(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}

export function Sidebar({
  conversations,
  activeId,
  disabled,
  onNew,
  onSelect,
  onSettings,
  onRename,
  onDelete,
  onExport,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">
          <Sparkles size={17} strokeWidth={1.8} />
        </div>
        <div>
          <strong>Quorum</strong>
          <span>Local intelligence</span>
        </div>
      </div>

      <button
        className="new-chat"
        type="button"
        disabled={disabled}
        onClick={onNew}
      >
        <Plus size={17} />
        New conversation
      </button>

      <div className="sidebar-label">Conversations</div>
      <nav className="conversation-list" aria-label="Conversations">
        {conversations.length === 0 ? (
          <p className="sidebar-empty">Your conversations stay on this machine.</p>
        ) : (
          conversations.map((conversation) => (
            <div
              className={`conversation-item ${
                conversation.id === activeId ? "is-active" : ""
              }`}
              key={conversation.id}
            >
              <button
                className="conversation-select"
                type="button"
                disabled={disabled}
                onClick={() => onSelect(conversation.id)}
              >
                <MessageSquare size={15} />
                <span>{conversation.title}</span>
                <time>{relativeTime(conversation.updatedAt)}</time>
              </button>
              <div className="conversation-actions">
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Rename ${conversation.title}`}
                  onClick={() => onRename(conversation)}
                >
                  <Pencil size={13} />
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Export ${conversation.title}`}
                  onClick={() => onExport(conversation)}
                >
                  <Download size={13} />
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Delete ${conversation.title}`}
                  onClick={() => onDelete(conversation)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))
        )}
      </nav>

      <button
        className="sidebar-settings"
        type="button"
        disabled={disabled}
        onClick={onSettings}
      >
        <Settings size={15} />
        Web search settings
      </button>
    </aside>
  );
}
