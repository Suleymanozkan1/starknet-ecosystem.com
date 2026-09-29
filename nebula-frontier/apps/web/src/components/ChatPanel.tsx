import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Icon, Tabs } from "@nebula/game-ui";
import type { MeResponse } from "@nebula/shared";
import { useChat, useFriends } from "../lib/queries.js";
import { useUi } from "../store/ui.js";
import { useGameLink } from "../store/gameLink.js";
import type { GameChatChannel } from "../store/gameLink.js";

type Channel = "GLOBAL" | "FACTION" | "CLAN" | "SQUAD" | "PRIVATE";

/**
 * Comms panel (Global / Faction / Clan / Squad / Private). History comes from GET /api/chat/history;
 * transmitting goes through the live game-server connection (server-side rate limits + moderation).
 */
export function ChatPanel({ me, embedded }: { me: MeResponse; embedded?: boolean }) {
  const [channel, setChannel] = useState<Channel>("GLOBAL");
  const [peer, setPeer] = useState("");
  const [text, setText] = useState("");
  const close = useUi((s) => s.setChatOpen);
  const sendChat = useGameLink((s) => s.sendChat);
  const friends = useFriends();
  const chat = useChat(channel, channel === "PRIVATE" ? peer || undefined : undefined, channel !== "PRIVATE" || peer.length > 0);
  const listRef = useRef<HTMLDivElement>(null);
  const messages = chat.data ?? [];
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  const canSend = Boolean(sendChat) && channel !== "PRIVATE";
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    const v = text.trim();
    if (!v || v.length > 200 || !sendChat || channel === "PRIVATE") return;
    sendChat(channel as GameChatChannel, v);
    setText("");
    window.setTimeout(() => void chat.refetch(), 600);
  };

  return (
    <aside
      className={embedded ? "nf-panel flex h-full flex-col" : "nf-panel fixed bottom-4 right-4 z-[70] flex h-[min(560px,70vh)] w-[min(380px,calc(100vw-32px))] flex-col"}
      aria-label="Chat"
    >
      <div className="nf-panel__header">
        <h2 className="nf-panel__title">Comms</h2>
        {!embedded && <button type="button" className="nf-modal__close" aria-label="Close chat" onClick={() => close(false)}><Icon name="close" size={16} /></button>}
      </div>
      <Tabs
        value={channel}
        onChange={setChannel}
        items={[
          { key: "GLOBAL", label: "Global" },
          { key: "FACTION", label: "Faction", disabled: !me.faction },
          { key: "CLAN", label: "Clan", disabled: !me.clan },
          { key: "SQUAD", label: "Squad" },
          { key: "PRIVATE", label: "Private" },
        ]}
      />
      {channel === "PRIVATE" && (
        <div className="border-b border-white/5 p-2">
          <select className="nf-input" value={peer} onChange={(e) => setPeer(e.target.value)} aria-label="Conversation">
            <option value="">{friends.data?.friends.length ? "Choose a friend…" : "Add friends to chat privately"}</option>
            {(friends.data?.friends ?? []).map((f) => <option key={f.id} value={f.id}>{f.username}{f.online ? " • online" : ""}</option>)}
          </select>
        </div>
      )}
      <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-2 text-[13.5px]">
        {chat.isLoading && <div className="nf-skeleton m-2 h-10" />}
        {chat.error ? <div className="p-3 text-[12.5px] text-mute">{channel === "SQUAD" ? "Join a squad to use this channel." : "Channel unavailable."}</div> : null}
        {!chat.isLoading && !chat.error && messages.length === 0 && <div className="p-6 text-center text-[12.5px] text-mute">No transmissions on this channel.</div>}
        {messages.map((m) => (
          <div key={m.id} className="py-1 leading-snug">
            <span className="mr-1.5 text-[10.5px] text-mute">{new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            <span className="nf-ui mr-1.5 font-bold" style={{ color: m.fromId === me.id ? "var(--nf-accent)" : "var(--nf-text)" }}>{m.from}</span>
            <span className="break-words text-dim">{m.text}</span>
          </div>
        ))}
      </div>
      <form onSubmit={onSubmit} className="flex gap-2 border-t border-white/5 p-2">
        <input
          className="nf-input"
          value={text}
          maxLength={200}
          disabled={!canSend}
          placeholder={channel === "PRIVATE" ? "Private replies are sent in-flight" : sendChat ? `Message ${channel.toLowerCase()}…` : "Launch into a sector to transmit"}
          onChange={(e) => setText(e.target.value)}
          aria-label="Message"
        />
        <button type="submit" className="nf-btn nf-btn--primary nf-btn--sm" disabled={!canSend || !text.trim()}>Send</button>
      </form>
    </aside>
  );
}
