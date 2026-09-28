import { create } from "zustand";

export type GameChatChannel = "LOCAL" | "GLOBAL" | "FACTION" | "CLAN" | "SQUAD";

/**
 * Bridge between the running game session (Play page) and menu UI such as the chat panel.
 * Chat messages are sent through the authoritative game server connection, never via REST.
 */
interface GameLinkState {
  sendChat: ((channel: GameChatChannel, text: string) => void) | null;
  setSendChat: (fn: ((channel: GameChatChannel, text: string) => void) | null) => void;
}

export const useGameLink = create<GameLinkState>()((set) => ({
  sendChat: null,
  setSendChat: (sendChat) => set({ sendChat }),
}));
