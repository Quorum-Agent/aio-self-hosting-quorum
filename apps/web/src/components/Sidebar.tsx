import { MessageSquare, Plus, Sparkles } from "lucide-react";

import type { ConversationRecord } from "../lib/api";

interface SidebarProps {
  conversations: ConversationRecord[];
  activeId: string;
  onNew: () => void;
  onSelect: (id: string) => void;
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
  onNew,
  onSelect,
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

      <button className="new-chat" type="button" onClick={onNew}>
        <Plus size={17} />
        New conversation
      </button>

      <div className="sidebar-label">Conversations</div>
      <nav className="conversation-list" aria-label="Conversations">
        {conversations.length === 0 ? (
          <p className="sidebar-empty">Your conversations stay on this machine.</p>
        ) : (
          conversations.map((conversation) => (
            <button
              className={`conversation-item ${
                conversation.id === activeId ? "is-active" : ""
              }`}
              key={conversation.id}
              type="button"
              onClick={() => onSelect(conversation.id)}
            >
              <MessageSquare size={15} />
              <span>{conversation.title}</span>
              <time>{relativeTime(conversation.updatedAt)}</time>
            </button>
          ))
        )}
      </nav>

    </aside>
  );
}
