export interface Entry {
  id: string;
  emotion: string;
  trigger: string;
  timestamp: Date;
  reminder?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  emotion?: string;
}

export interface Memory {
  id: string;
  summary: string;
  event: string;
  emotions: string[];
  timestamp: Date;
  entryId: string;
}

export interface Insight {
  id: string;
  type: 'pattern' | 'reflection' | 'guidance';
  title: string;
  content: string;
  relatedEmotions: string[];
  timestamp: Date;
}

export interface ReEngagementPrompt {
  id: string;
  type: 'curiosity' | 'nudge';
  content: string;
  timestamp: Date;
}
