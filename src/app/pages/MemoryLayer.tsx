import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useAppContext } from '../context/AppContext';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Textarea } from '../components/ui/textarea';
import { Badge } from '../components/ui/badge';
import { Brain, Sparkles, ArrowRight, Edit3 } from 'lucide-react';
import { motion } from 'motion/react';

export const MemoryLayer: React.FC = () => {
  const navigate = useNavigate();
  const { currentEntry, chatMessages, addMemory } = useAppContext();
  const [autoSummary, setAutoSummary] = useState('');
  const [isGenerating, setIsGenerating] = useState(true);
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    if (!currentEntry) {
      navigate('/');
      return;
    }

    // Generate auto-summary from chat messages
    setTimeout(() => {
      const userMessages = chatMessages.filter(m => m.role === 'user').map(m => m.content);
      const summary = generateSummary(currentEntry, userMessages);
      setAutoSummary(summary);
      setIsGenerating(false);
    }, 1500);
  }, [currentEntry, chatMessages, navigate]);

  const generateSummary = (entry: any, userMessages: string[]): string => {
    const mainTheme = userMessages.length > 0 
      ? userMessages[0].split('.')[0] 
      : entry.trigger;
    
    const emotional_arc = userMessages.length > 2 
      ? 'Through our conversation, you explored these feelings and found some clarity.'
      : 'You shared your feelings openly.';
    
    return `Today you felt ${entry.emotion.toLowerCase()} because ${mainTheme}. ${emotional_arc} Your trigger was: "${entry.trigger}"`;
  };

  const handleContinue = () => {
    if (!currentEntry) return;

    const memory = {
      id: Date.now().toString(),
      summary: autoSummary,
      event: currentEntry.trigger,
      emotions: [currentEntry.emotion],
      timestamp: new Date(),
      entryId: currentEntry.id,
    };

    addMemory(memory);
    navigate('/insights');
  };

  if (!currentEntry) return null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 via-blue-50 to-purple-50 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-3xl"
      >
        <Card className="shadow-xl">
          <CardHeader className="text-center space-y-4">
            <div className="mx-auto w-16 h-16 bg-green-500 rounded-full flex items-center justify-center">
              <Brain className="w-8 h-8 text-white" />
            </div>
            <CardTitle className="text-3xl">Memory Saved</CardTitle>
            <CardDescription className="text-base">
              Here's a summary of your emotional journey today
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-6">
            {isGenerating ? (
              <div className="flex flex-col items-center justify-center py-12 space-y-4">
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
                >
                  <Sparkles className="w-12 h-12 text-green-500" />
                </motion.div>
                <p className="text-muted-foreground">Generating your memory summary...</p>
              </div>
            ) : (
              <>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-medium">Auto-Generated Summary</h3>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setIsEditing(!isEditing)}
                    >
                      <Edit3 className="w-4 h-4 mr-1" />
                      {isEditing ? 'Done' : 'Edit'}
                    </Button>
                  </div>
                  
                  {isEditing ? (
                    <Textarea
                      value={autoSummary}
                      onChange={(e) => setAutoSummary(e.target.value)}
                      rows={5}
                      className="text-base"
                    />
                  ) : (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="bg-green-50 border border-green-200 rounded-lg p-4"
                    >
                      <p className="text-base leading-relaxed">{autoSummary}</p>
                    </motion.div>
                  )}
                </div>

                <div className="space-y-3">
                  <h3 className="font-medium">Emotion Tag</h3>
                  <div>
                    <Badge variant="secondary" className="text-base px-3 py-1">
                      {currentEntry.emotion}
                    </Badge>
                  </div>
                </div>

                <div className="space-y-3">
                  <h3 className="font-medium">Conversation Highlights</h3>
                  <div className="bg-gray-50 border rounded-lg p-4 space-y-2">
                    <p className="text-sm text-muted-foreground">
                      Messages exchanged: {chatMessages.length}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Time: {new Date().toLocaleTimeString()}
                    </p>
                    {currentEntry.reminder && (
                      <p className="text-sm font-medium text-green-700">
                        Your reminder: "{currentEntry.reminder}"
                      </p>
                    )}
                  </div>
                </div>

                <Button onClick={handleContinue} className="w-full" size="lg">
                  <ArrowRight className="w-5 h-5 mr-2" />
                  View Insights
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
};
