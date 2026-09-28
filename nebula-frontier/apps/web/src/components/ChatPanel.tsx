import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Icon, Tabs } from "@nebula/game-ui";
import type { MeResponse } from "@nebula/shared";
import { api } from "../lib/api.js";
import { qk, useApiMutation, useChat } from "../lib/queries.js";
import { factionColor } from "../lib/gameMeta.js";
import { useUi } from "../store/ui.js";

type Channel = "GLOBAL" | "FACTION" | "CLAN" | "SQUAD" | "PRIVATE";

/** Slide-over social chat (Global / Faction / Clan / Squad / Private). */
export function ChatPanel({ me, embedded }: { me: MeResponse; embedded?: boolean }) {
  const [channel, setChannel] = useState<Channel>("GLOBAL");
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const close = useUi((s) => s.setChatOpen);
  const chat = useChat(channel, channel === "PRIVATE" ? to || undefined : undefined, channel !== "PRIVATE" || to.length > 0);
  const send = useApiMutation((v: { text: string }) => api.chat.send(channel, v.text, channel === "PRIVATE" ? to : undefined), {
    invalidate: [qk.chat(channel, channel === "PRIVATE" ? to || undefined : undefined)],
    errorTitle: "Message not sent",
    onSuccess: () => setText(""),
  });
  const listRef = useRef<HTMLDivElement>(null);
  const messages = [...(chat.data ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    const v = text.trim();
    if (!v || v.length > 280) return;
    send.mutate({ text: v });
  };
  const disabled = (channel === "CLAN" && !me.clan) || (channel === "FACTION" && !me.faction);

  return (
    <aside
      className={embedded ? "nf-panel flex h-full flex-col" : "nf-panel fixed bottom-4 right-4 z-[70] flex h-[min(560px,70vh)] w-[min(380px,calc(100vw-32px))] flex-col"}
      aria-label="Chat"
    >
      <div className="nf-panel__header">
        <h2 className="nf-panel__title">Comms</h2>
        {!embedded && (
          <button type="button" className="nf-modal__close" aria-label="Close chat" onClick={() => close(false)}><Icon name="close" size={16} /></button>
        )}
      </div>
      <Tabs
        variant="underline"
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
          <input className="nf-input" placeholder="Recipient callsign" value={to} maxLength={24} onChange={(e) => setTo(e.target.value.trim())} />
        </div>
      )}
      <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-2 text-[13.5px]">
        {chat.isLoading && <div className="nf-skeleton m-2 h-10" />}
        {chat.error ? <div className="p-3 text-[12.5px] text-bad">Channel unavailable.</div> : null}
        {!chat.isLoading && !chat.error && messages.length === 0 && <div className="p-6 text-center text-[12.5px] text-mute">No transmissions on this channel.</div>}
        {messages.map((m) => (
          <div key={m.id} className="py-1 leading-snug">
            <span className="nf-ui mr-1.5 font-bold" style={{ color: factionColor(m.faction ?? null) }}>{m.from}</span>
            <span className="break-words text-ink/90">{m.text}</span>
          </div>
        ))}
      </div>
      <form onSubmit={onSubmit} className="flex gap-2 border-t border-white/5 p-2">
        <input
          className="nf-input"
          value={text}
          maxLength={280}
          disabled={disabled || (channel === "PRIVATE" && !to)}
          placeholder={disabled ? "Channel unavailable" : `Message ${channel.toLowerCase()}…`}
          onChange={(e) => setText(e.target.value)}
          aria-label="Message"
        />
        <button type="submit" className="nf-btn nf-btn--primary nf-btn--sm" disabled={!text.trim() || send.isPending || disabled}>
          Send
        </button>
      </form>
    </aside>
  );
}
