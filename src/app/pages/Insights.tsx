import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useAppContext } from '../context/AppContext';
import { detectPatterns } from '../utils/aiResponses';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Badge } from '../components/ui/badge';
import { Lightbulb, TrendingUp, BookOpen, ArrowRight, Sparkles } from 'lucide-react';
import { motion } from 'motion/react';

export const Insights: React.FC = () => {
  const navigate = useNavigate();
  const { allEntries, memories, insights, addInsight } = useAppContext();
  const [patterns, setPatterns] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Detect patterns and generate insights
    setTimeout(() => {
      const detectedPatterns = detectPatterns(allEntries, memories);
      setPatterns(detectedPatterns);

      // Generate new insights if we have enough data
      if (allEntries.length > 0 && insights.length < 3) {
        const newInsight = {
          id: Date.now().toString(),
          type: 'reflection' as const,
          title: 'Your Emotional Growth',
          content: generateInsightContent(allEntries),
          relatedEmotions: allEntries.map(e => e.emotion),
          timestamp: new Date(),
        };
        addInsight(newInsight);
      }

      setIsLoading(false);
    }, 1200);
  }, [allEntries, memories, insights.length, addInsight]);

  const generateInsightContent = (entries: any[]): string => {
    if (entries.length === 1) {
      return "Taking the first step to understand your emotions shows self-awareness and courage. This is the beginning of a meaningful journey.";
    }
    
    if (entries.length < 5) {
      return `You've completed ${entries.length} emotional check-ins. Regular reflection is building your emotional intelligence and self-awareness.`;
    }
    
    return `With ${entries.length} entries, you're building a rich emotional history. This consistent practice is transforming how you understand yourself.`;
  };

  const reflections = [
    {
      title: 'Self-Awareness',
      content: 'By naming and exploring your emotions, you\'re developing a deeper understanding of your inner world.',
      icon: BookOpen,
    },
    {
      title: 'Emotional Processing',
      content: 'Each conversation helps you process feelings in a healthy way, rather than suppressing them.',
      icon: Sparkles,
    },
    {
      title: 'Growth Mindset',
      content: 'You\'re learning that emotions are temporary and manageable, fostering resilience.',
      icon: TrendingUp,
    },
  ];

  const guidanceItems = [
    'Continue checking in daily, even when you feel neutral or positive',
    'Notice how your triggers evolve over time',
    'Celebrate small victories in emotional regulation',
    'Be patient with yourself during difficult periods',
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-yellow-50 via-orange-50 to-red-50 p-4 py-12">
      <div className="max-w-5xl mx-auto space-y-6">
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center space-y-2"
        >
          <div className="mx-auto w-16 h-16 bg-yellow-500 rounded-full flex items-center justify-center">
            <Lightbulb className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-4xl font-bold">Your Insights</h1>
          <p className="text-muted-foreground text-lg">
            Patterns, reflections, and guidance for your journey
          </p>
        </motion.div>

        {isLoading ? (
          <Card className="shadow-xl">
            <CardContent className="flex flex-col items-center justify-center py-16 space-y-4">
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
              >
                <Sparkles className="w-12 h-12 text-yellow-500" />
              </motion.div>
              <p className="text-muted-foreground">Analyzing your patterns...</p>
            </CardContent>
          </Card>
        ) : (
          <>
            <Tabs defaultValue="patterns" className="w-full">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="patterns">Patterns</TabsTrigger>
                <TabsTrigger value="reflections">Reflections</TabsTrigger>
                <TabsTrigger value="guidance">Guidance</TabsTrigger>
              </TabsList>

              <TabsContent value="patterns" className="space-y-4">
                <Card className="shadow-xl">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <TrendingUp className="w-5 h-5" />
                      Pattern Detection
                    </CardTitle>
                    <CardDescription>
                      What we've learned about your emotional landscape
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {patterns.length > 0 ? (
                      patterns.map((pattern, index) => (
                        <motion.div
                          key={index}
                          initial={{ opacity: 0, x: -20 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: index * 0.1 }}
                          className="bg-yellow-50 border border-yellow-200 rounded-lg p-4"
                        >
                          <p className="text-base">{pattern}</p>
                        </motion.div>
                      ))
                    ) : (
                      <div className="text-center py-8 space-y-3">
                        <p className="text-muted-foreground">
                          Keep journaling! We need a few more entries to detect meaningful patterns.
                        </p>
                        <p className="text-sm text-muted-foreground">
                          Entries so far: {allEntries.length}
                        </p>
                      </div>
                    )}

                    {allEntries.length >= 3 && (
                      <div className="pt-4 space-y-3">
                        <h4 className="font-medium">Recent Emotions</h4>
                        <div className="flex flex-wrap gap-2">
                          {allEntries.slice(-5).map((entry, index) => (
                            <Badge key={index} variant="outline">
                              {entry.emotion}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="reflections" className="space-y-4">
                {reflections.map((reflection, index) => (
                  <motion.div
                    key={index}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.1 }}
                  >
                    <Card className="shadow-xl">
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                          <reflection.icon className="w-5 h-5 text-orange-500" />
                          {reflection.title}
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <p className="text-base leading-relaxed">{reflection.content}</p>
                      </CardContent>
                    </Card>
                  </motion.div>
                ))}
              </TabsContent>

              <TabsContent value="guidance" className="space-y-4">
                <Card className="shadow-xl">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <BookOpen className="w-5 h-5" />
                      Personal Guidance
                    </CardTitle>
                    <CardDescription>
                      Suggestions to deepen your emotional practice
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-3">
                      {guidanceItems.map((item, index) => (
                        <motion.li
                          key={index}
                          initial={{ opacity: 0, x: -20 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: index * 0.1 }}
                          className="flex items-start gap-3 bg-orange-50 border border-orange-200 rounded-lg p-4"
                        >
                          <div className="w-6 h-6 bg-orange-500 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                            <span className="text-white text-sm font-medium">{index + 1}</span>
                          </div>
                          <p className="text-base flex-1">{item}</p>
                        </motion.li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>

            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5 }}
            >
              <Button
                onClick={() => navigate('/re-engagement')}
                className="w-full"
                size="lg"
              >
                <ArrowRight className="w-5 h-5 mr-2" />
                Continue
              </Button>
            </motion.div>
          </>
        )}
      </div>
    </div>
  );
};
