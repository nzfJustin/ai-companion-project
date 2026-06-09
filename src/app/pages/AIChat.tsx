import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useAppContext } from '../context/AppContext';
import { generateAIResponse } from '../utils/aiResponses';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { ScrollArea } from '../components/ui/scroll-area';
import { MessageCircle, Send, ArrowRight } from 'lucide-react';
import { motion } from 'motion/react';

export const AIChat: React.FC = () => {
  const navigate = useNavigate();
  const { currentEntry, chatMessages, addChatMessage } = useAppContext();
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!currentEntry) {
      navigate('/');
      return;
    }

    // Send initial AI greeting if no messages yet
    if (chatMessages.length === 0) {
      setTimeout(() => {
        const greeting = {
          id: Date.now().toString(),
          role: 'assistant' as const,
          content: generateAIResponse('', currentEntry.emotion, []),
          timestamp: new Date(),
          emotion: currentEntry.emotion,
        };
        addChatMessage(greeting);
      }, 500);
    }
  }, [currentEntry, chatMessages.length, navigate, addChatMessage]);

  useEffect(() => {
    // Scroll to bottom when new messages arrive
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, isTyping]);

  const handleSend = async () => {
    if (!input.trim() || !currentEntry) return;

    const userMessage = {
      id: Date.now().toString(),
      role: 'user' as const,
      content: input,
      timestamp: new Date(),
    };

    addChatMessage(userMessage);
    setInput('');
    setIsTyping(true);

    // Simulate AI thinking time
    setTimeout(() => {
      const aiResponse = {
        id: (Date.now() + 1).toString(),
        role: 'assistant' as const,
        content: generateAIResponse(input, currentEntry.emotion, chatMessages),
        timestamp: new Date(),
        emotion: currentEntry.emotion,
      };
      addChatMessage(aiResponse);
      setIsTyping(false);
    }, 1000 + Math.random() * 1000);
  };

  const handleContinue = () => {
    navigate('/memory');
  };

  if (!currentEntry) return null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 via-pink-50 to-blue-50 flex items-center justify-center p-4">
      <Card className="w-full max-w-4xl h-[80vh] flex flex-col shadow-xl">
        <CardHeader className="border-b">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 bg-purple-500 rounded-full flex items-center justify-center">
                <MessageCircle className="w-6 h-6 text-white" />
              </div>
              <div>
                <CardTitle>AI Companion</CardTitle>
                <p className="text-sm text-muted-foreground">
                  I'm here to listen and support you
                </p>
              </div>
            </div>
            {chatMessages.length >= 4 && (
              <Button onClick={handleContinue} variant="outline">
                Save & Continue
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            )}
          </div>
        </CardHeader>

        <CardContent className="flex-1 flex flex-col p-0">
          <ScrollArea className="flex-1 p-6">
            <div className="space-y-4">
              {chatMessages.map((message, index) => (
                <motion.div
                  key={message.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                  className={`flex ${
                    message.role === 'user' ? 'justify-end' : 'justify-start'
                  }`}
                >
                  <div
                    className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                      message.role === 'user'
                        ? 'bg-purple-500 text-white'
                        : 'bg-gray-100 text-gray-900'
                    }`}
                  >
                    <p className="text-sm leading-relaxed">{message.content}</p>
                  </div>
                </motion.div>
              ))}
              
              {isTyping && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex justify-start"
                >
                  <div className="bg-gray-100 rounded-2xl px-4 py-3">
                    <div className="flex gap-1">
                      <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                      <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                      <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  </div>
                </motion.div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </ScrollArea>

          <div className="border-t p-4">
            <div className="flex gap-2">
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleSend()}
                placeholder="Share your thoughts..."
                className="flex-1"
              />
              <Button onClick={handleSend} disabled={!input.trim() || isTyping}>
                <Send className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};