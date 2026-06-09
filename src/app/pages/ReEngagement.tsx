import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useAppContext } from '../context/AppContext';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Sparkles, RefreshCw, Calendar, TrendingUp, Home } from 'lucide-react';
import { motion } from 'motion/react';

const curiosityPrompts = [
  "What small thing brought you joy today?",
  "How did you show yourself kindness this week?",
  "What would your future self thank you for doing today?",
  "What pattern are you most curious to explore next?",
  "If your emotions could teach you something today, what would it be?",
];

const nudges = [
  "It's been a while since your last check-in. How are you feeling?",
  "Remember: small steps, big changes. Ready for another reflection?",
  "Your emotional journey continues. Take a moment to check in.",
  "Growth happens in the quiet moments. Let's reflect together.",
  "You've been making progress. Keep the momentum going!",
];

export const ReEngagement: React.FC = () => {
  const navigate = useNavigate();
  const { allEntries, memories, insights, addPrompt } = useAppContext();
  const [currentPrompt, setCurrentPrompt] = useState('');
  const [promptType, setPromptType] = useState<'curiosity' | 'nudge'>('curiosity');
  const [showStats, setShowStats] = useState(false);
  const hasInitialized = useRef(false);

  useEffect(() => {
    // Prevent running multiple times
    if (hasInitialized.current) return;
    hasInitialized.current = true;

    // Select a random prompt based on user's progress
    const promptList = allEntries.length < 3 ? nudges : curiosityPrompts;
    const type = allEntries.length < 3 ? 'nudge' : 'curiosity';
    const randomPrompt = promptList[Math.floor(Math.random() * promptList.length)];
    
    setCurrentPrompt(randomPrompt);
    setPromptType(type);

    // Add to re-engagement prompts history
    const newPrompt = {
      id: Date.now().toString(),
      type,
      content: randomPrompt,
      timestamp: new Date(),
    };
    addPrompt(newPrompt);

    // Show stats after a brief delay
    setTimeout(() => setShowStats(true), 800);
  }, []); // Empty dependency array - only run once

  const handleStartNewEntry = () => {
    navigate('/');
  };

  const handleViewHistory = () => {
    // Navigate to a history view (could be expanded later)
    navigate('/memory');
  };

  const getTotalMessageCount = () => {
    return allEntries.length * 4; // Approximate messages per session
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-red-50 via-pink-50 to-purple-50 p-4 py-12">
      <div className="max-w-4xl mx-auto space-y-6">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="text-center space-y-4"
        >
          <div className="mx-auto w-20 h-20 bg-gradient-to-br from-red-500 to-pink-500 rounded-full flex items-center justify-center">
            <RefreshCw className="w-10 h-10 text-white" />
          </div>
          <h1 className="text-4xl font-bold">Building Your Habit Loop</h1>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
            Consistent reflection creates lasting change. You're developing emotional awareness one session at a time.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <Card className="shadow-xl border-2 border-pink-200 bg-gradient-to-br from-pink-50 to-purple-50">
            <CardHeader className="text-center">
              <div className="mx-auto w-12 h-12 bg-pink-500 rounded-full flex items-center justify-center mb-3">
                <Sparkles className="w-6 h-6 text-white" />
              </div>
              <CardTitle className="text-2xl">
                {promptType === 'curiosity' ? 'A Question for You' : 'Gentle Nudge'}
              </CardTitle>
              <CardDescription className="text-base">
                {promptType === 'curiosity' 
                  ? 'Deepen your self-awareness with this reflection'
                  : 'Keep your momentum going'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.4 }}
                className="bg-white rounded-xl p-6 border-2 border-pink-200 shadow-md"
              >
                <p className="text-xl text-center font-medium leading-relaxed">
                  {currentPrompt}
                </p>
              </motion.div>

              <div className="flex flex-col sm:flex-row gap-3">
                <Button
                  onClick={handleStartNewEntry}
                  size="lg"
                  className="flex-1"
                >
                  <Sparkles className="w-5 h-5 mr-2" />
                  Start New Entry
                </Button>
                <Button
                  onClick={handleViewHistory}
                  size="lg"
                  variant="outline"
                  className="flex-1"
                >
                  <Calendar className="w-5 h-5 mr-2" />
                  View Memories
                </Button>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {showStats && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6 }}
          >
            <Card className="shadow-xl">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="w-5 h-5 text-red-500" />
                  Your Journey So Far
                </CardTitle>
                <CardDescription>
                  Celebrate your progress and consistency
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <motion.div
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 0.7 }}
                    className="text-center space-y-2"
                  >
                    <div className="text-4xl font-bold text-red-600">
                      {allEntries.length}
                    </div>
                    <p className="text-sm text-muted-foreground uppercase tracking-wide">
                      Journal Entries
                    </p>
                    <Badge variant="secondary" className="mt-2">
                      {allEntries.length < 5 ? 'Getting Started' : 
                       allEntries.length < 15 ? 'Building Momentum' : 
                       'Committed'}
                    </Badge>
                  </motion.div>

                  <motion.div
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 0.8 }}
                    className="text-center space-y-2"
                  >
                    <div className="text-4xl font-bold text-pink-600">
                      {memories.length}
                    </div>
                    <p className="text-sm text-muted-foreground uppercase tracking-wide">
                      Memories Saved
                    </p>
                    <Badge variant="secondary" className="mt-2">
                      {memories.length < 5 ? 'Growing' : 'Rich History'}
                    </Badge>
                  </motion.div>

                  <motion.div
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 0.9 }}
                    className="text-center space-y-2"
                  >
                    <div className="text-4xl font-bold text-purple-600">
                      {insights.length}
                    </div>
                    <p className="text-sm text-muted-foreground uppercase tracking-wide">
                      Insights Discovered
                    </p>
                    <Badge variant="secondary" className="mt-2">
                      {insights.length < 3 ? 'Learning' : 'Self-Aware'}
                    </Badge>
                  </motion.div>
                </div>

                {allEntries.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 1.0 }}
                    className="mt-8 pt-6 border-t text-center space-y-3"
                  >
                    <p className="text-sm text-muted-foreground">
                      Last entry: {new Date(allEntries[allEntries.length - 1].timestamp).toLocaleDateString()}
                    </p>
                    <div className="flex justify-center gap-2">
                      <Badge variant="outline">
                        {allEntries.length} emotional check-ins
                      </Badge>
                      <Badge variant="outline">
                        ~{getTotalMessageCount()} conversations
                      </Badge>
                    </div>
                  </motion.div>
                )}
              </CardContent>
            </Card>
          </motion.div>
        )}

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.1 }}
          className="text-center"
        >
          <Button
            onClick={() => navigate('/')}
            variant="ghost"
            size="lg"
          >
            <Home className="w-5 h-5 mr-2" />
            Back to Home
          </Button>
        </motion.div>
      </div>
    </div>
  );
};