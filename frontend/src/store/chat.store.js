import { create } from "zustand";
import { chatMessages } from "../constants/mockData";

export const useChatStore = create((set) => ({
  messages: chatMessages,
  addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
}));
