import { ChatMessage } from '../types';

// Simple AI response generator based on emotion and content
export const generateAIResponse = (
  userMessage: string,
  emotion: string,
  previousMessages: ChatMessage[]
): string => {
  const lowerMessage = userMessage.toLowerCase();
  
  // Emotion-specific empathetic responses
  const emotionResponses: { [key: string]: string[] } = {
    anxious: [
      "I hear that you're feeling anxious. That takes courage to acknowledge. What's weighing on your mind right now?",
      "Anxiety can feel overwhelming. Let's explore this together. What triggered these feelings?",
      "It's okay to feel anxious. Your feelings are valid. Can you tell me more about what's happening?",
    ],
    sad: [
      "I'm here with you in this sadness. Would you like to share what's making you feel this way?",
      "Sadness is a natural emotion. Thank you for trusting me with this. What's going on?",
      "I can sense your pain. You don't have to go through this alone. Tell me more about how you're feeling.",
    ],
    angry: [
      "I can feel the intensity of your anger. It's important to express these feelings. What happened?",
      "Anger is a powerful emotion that tells us something important. What's behind this feeling?",
      "Your anger is valid. Let's work through this together. What triggered this response?",
    ],
    happy: [
      "I love hearing about what makes you happy! Tell me more about this joy you're experiencing.",
      "That's wonderful! Happiness is precious. What's bringing you this positive energy?",
      "Your happiness is contagious! I'd love to hear more about what's going well for you.",
    ],
    stressed: [
      "Stress can be exhausting. I'm here to listen. What's contributing to these feelings?",
      "It sounds like you're carrying a lot right now. Let's unpack this together. What's on your plate?",
      "Feeling stressed is your mind's way of signaling overload. What's the biggest pressure point right now?",
    ],
    overwhelmed: [
      "Being overwhelmed is a signal to pause. You're doing the right thing by reaching out. What feels most pressing?",
      "It's brave to admit you're overwhelmed. Let's break this down together. Where should we start?",
      "I'm here to help you sort through this. What's making you feel most overwhelmed right now?",
    ],
    lonely: [
      "Loneliness can be so difficult. I'm glad you're here. You're not alone in this space. Tell me what you're experiencing.",
      "I hear you, and your feelings matter. What's contributing to your sense of loneliness?",
      "Thank you for being vulnerable about feeling lonely. I'm here with you. What's going on?",
    ],
    confused: [
      "Confusion is often the first step to clarity. Let's explore this together. What's puzzling you?",
      "It's okay not to have all the answers. Tell me what's creating this confusion for you.",
      "Sometimes talking through confusion helps. I'm here to listen. What's on your mind?",
    ],
  };

  // Conversation continuation patterns
  if (lowerMessage.includes('work') || lowerMessage.includes('job')) {
    return "Work situations can be challenging. How is this affecting your well-being? What would make things better?";
  }
  
  if (lowerMessage.includes('relationship') || lowerMessage.includes('friend') || lowerMessage.includes('family')) {
    return "Relationships are at the heart of our emotional lives. Tell me more about what's happening with this connection.";
  }
  
  if (lowerMessage.includes('better') || lowerMessage.includes('help')) {
    return "I'm here to support you. What does feeling better look like for you right now? What small step could you take today?";
  }

  if (lowerMessage.includes('thank') || lowerMessage.includes('appreciate')) {
    return "You're very welcome. I'm honored to be part of your journey. How are you feeling now?";
  }

  if (lowerMessage.includes('i feel') || lowerMessage.includes('im feeling') || lowerMessage.includes("i'm feeling")) {
    return "Thank you for sharing how you feel. Your emotions are important and valid. What do you need right now?";
  }

  // Default empathetic responses based on emotion
  const responses = emotionResponses[emotion.toLowerCase()] || [
    "I'm listening. Tell me more about what you're experiencing.",
    "Thank you for sharing this with me. How can I support you right now?",
    "Your feelings are valid. What else would you like to explore?",
  ];

  // Choose response based on conversation length
  const index = previousMessages.length % responses.length;
  return responses[index];
};

// Generate insights based on patterns
export const detectPatterns = (entries: any[], memories: any[]): string[] => {
  const patterns: string[] = [];
  
  if (entries.length >= 3) {
    const emotions = entries.map(e => e.emotion.toLowerCase());
    const emotionCounts: { [key: string]: number } = {};
    
    emotions.forEach(e => {
      emotionCounts[e] = (emotionCounts[e] || 0) + 1;
    });
    
    const maxEmotion = Object.keys(emotionCounts).reduce((a, b) => 
      emotionCounts[a] > emotionCounts[b] ? a : b
    );
    
    if (emotionCounts[maxEmotion] >= 3) {
      patterns.push(`You've been experiencing ${maxEmotion} emotions frequently in recent entries.`);
    }
  }
  
  if (memories.length >= 2) {
    const recentMemories = memories.slice(-5);
    const commonWords: { [key: string]: number } = {};
    
    recentMemories.forEach((m: any) => {
      const words = m.event.toLowerCase().split(/\s+/);
      words.forEach(word => {
        if (word.length > 4) {
          commonWords[word] = (commonWords[word] || 0) + 1;
        }
      });
    });
    
    const recurring = Object.keys(commonWords).filter(w => commonWords[w] >= 2);
    if (recurring.length > 0) {
      patterns.push(`Recurring themes in your experiences: ${recurring.slice(0, 3).join(', ')}`);
    }
  }
  
  return patterns;
};
