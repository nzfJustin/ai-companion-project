import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { Entry, ChatMessage, Memory, Insight, ReEngagementPrompt } from '../types';

interface AppContextType {
  currentEntry: Entry | null;
  setCurrentEntry: (entry: Entry | null) => void;
  
  chatMessages: ChatMessage[];
  addChatMessage: (message: ChatMessage) => void;
  clearChat: () => void;
  
  memories: Memory[];
  addMemory: (memory: Memory) => void;
  
  insights: Insight[];
  addInsight: (insight: Insight) => void;
  
  prompts: ReEngagementPrompt[];
  addPrompt: (prompt: ReEngagementPrompt) => void;
  
  allEntries: Entry[];
  addEntry: (entry: Entry) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [currentEntry, setCurrentEntry] = useState<Entry | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [prompts, setPrompts] = useState<ReEngagementPrompt[]>([]);
  const [allEntries, setAllEntries] = useState<Entry[]>([]);

  // Load from localStorage on mount
  useEffect(() => {
    const storedMemories = localStorage.getItem('memories');
    const storedInsights = localStorage.getItem('insights');
    const storedPrompts = localStorage.getItem('prompts');
    const storedEntries = localStorage.getItem('entries');

    if (storedMemories) setMemories(JSON.parse(storedMemories));
    if (storedInsights) setInsights(JSON.parse(storedInsights));
    if (storedPrompts) setPrompts(JSON.parse(storedPrompts));
    if (storedEntries) setAllEntries(JSON.parse(storedEntries));
  }, []);

  // Save to localStorage when data changes
  useEffect(() => {
    localStorage.setItem('memories', JSON.stringify(memories));
  }, [memories]);

  useEffect(() => {
    localStorage.setItem('insights', JSON.stringify(insights));
  }, [insights]);

  useEffect(() => {
    localStorage.setItem('prompts', JSON.stringify(prompts));
  }, [prompts]);

  useEffect(() => {
    localStorage.setItem('entries', JSON.stringify(allEntries));
  }, [allEntries]);

  const addChatMessage = (message: ChatMessage) => {
    setChatMessages(prev => [...prev, message]);
  };

  const clearChat = () => {
    setChatMessages([]);
  };

  const addMemory = (memory: Memory) => {
    setMemories(prev => [...prev, memory]);
  };

  const addInsight = (insight: Insight) => {
    setInsights(prev => [...prev, insight]);
  };

  const addPrompt = (prompt: ReEngagementPrompt) => {
    setPrompts(prev => [...prev, prompt]);
  };

  const addEntry = (entry: Entry) => {
    setAllEntries(prev => [...prev, entry]);
  };

  return (
    <AppContext.Provider
      value={{
        currentEntry,
        setCurrentEntry,
        chatMessages,
        addChatMessage,
        clearChat,
        memories,
        addMemory,
        insights,
        addInsight,
        prompts,
        addPrompt,
        allEntries,
        addEntry,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useAppContext = () => {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useAppContext must be used within an AppProvider');
  }
  return context;
};
