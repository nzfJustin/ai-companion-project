import React, { useState } from 'react';
import { useNavigate } from 'react-router';
import { useAppContext } from '../context/AppContext';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Textarea } from '../components/ui/textarea';
import { Heart, Sparkles } from 'lucide-react';

const emotions = [
  'Anxious',
  'Sad',
  'Angry',
  'Happy',
  'Stressed',
  'Overwhelmed',
  'Lonely',
  'Confused',
  'Grateful',
  'Hopeful',
  'Excited',
  'Calm',
];

export const Entry: React.FC = () => {
  const navigate = useNavigate();
  const { setCurrentEntry, addEntry, clearChat } = useAppContext();
  const [emotion, setEmotion] = useState('');
  const [trigger, setTrigger] = useState('');
  const [reminder, setReminder] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!emotion || !trigger) return;

    const entry = {
      id: Date.now().toString(),
      emotion,
      trigger,
      timestamp: new Date(),
      reminder: reminder || undefined,
    };

    setCurrentEntry(entry);
    addEntry(entry);
    clearChat();
    navigate('/chat');
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-purple-50 to-pink-50 flex items-center justify-center p-4">
      <Card className="w-full max-w-2xl shadow-xl">
        <CardHeader className="text-center space-y-4">
          <div className="mx-auto w-16 h-16 bg-blue-500 rounded-full flex items-center justify-center">
            <Heart className="w-8 h-8 text-white" />
          </div>
          <CardTitle className="text-3xl">Welcome to Your Emotional Journey</CardTitle>
          <CardDescription className="text-base">
            Let's start by understanding what you're feeling right now
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="emotion" className="text-base">
                How are you feeling? <span className="text-red-500">*</span>
              </Label>
              <Select value={emotion} onValueChange={setEmotion}>
                <SelectTrigger id="emotion">
                  <SelectValue placeholder="Select your emotion" />
                </SelectTrigger>
                <SelectContent>
                  {emotions.map((e) => (
                    <SelectItem key={e} value={e}>
                      {e}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="trigger" className="text-base">
                What triggered this feeling? <span className="text-red-500">*</span>
              </Label>
              <Textarea
                id="trigger"
                placeholder="Describe what happened or what's on your mind..."
                value={trigger}
                onChange={(e) => setTrigger(e.target.value)}
                rows={4}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="reminder" className="text-base">
                Set a reminder for yourself (optional)
              </Label>
              <Input
                id="reminder"
                placeholder="e.g., Remember to breathe, You've got this, etc."
                value={reminder}
                onChange={(e) => setReminder(e.target.value)}
              />
            </div>

            <Button
              type="submit"
              className="w-full"
              size="lg"
              disabled={!emotion || !trigger}
            >
              <Sparkles className="w-5 h-5 mr-2" />
              Continue to Chat
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};
