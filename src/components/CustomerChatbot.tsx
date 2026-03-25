'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Send, X, Camera, Mic, MicOff } from 'lucide-react';
import { ChatMessage } from '@/types/job';
import PhoneVerification from './PhoneVerification';
import MyJobsList from './MyJobsList';

interface Photo {
  file: File;
  preview: string;
  id: string;
}

type AppView = 'loading' | 'my_jobs' | 'chat';

const STORAGE_KEY = 'ojt_current_job';

const OPENING_MESSAGE: ChatMessage = {
  id: '1',
  role: 'assistant',
  content: "G'day! I'm Todd's AI assistant. I'm here to help Todd understand your job properly so he can tell you whether he can help.\n\nWhat do you need done? You can type, send photos, or press the mic and talk me through it.",
  timestamp: new Date().toISOString(),
};

export default function CustomerChatbot() {
  // ── Session state ──
  const [view, setView] = useState<AppView>('loading');
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  // ── Chat state ──
  const [messages, setMessages] = useState<ChatMessage[]>([OPENING_MESSAGE]);
  const [currentMessage, setCurrentMessage] = useState('');
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [conversationPhase, setConversationPhase] = useState<string | null>(null);
  const [showPhoneVerification, setShowPhoneVerification] = useState(false);

  // ── Voice input state ──
  const [isListening, setIsListening] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);

  // ── Session detection on mount ──
  useEffect(() => {
    checkSession();
  }, []);

  const checkSession = async () => {
    // ?fresh param: clear all session state and start a new conversation
    const params = new URLSearchParams(window.location.search);
    if (params.has('fresh')) {
      localStorage.removeItem(STORAGE_KEY);
      fetch('/api/v2/auth/logout', { method: 'POST' }).catch(() => {});
      // Strip ?fresh from URL so refresh doesn't keep clearing
      const url = new URL(window.location.href);
      url.searchParams.delete('fresh');
      window.history.replaceState({}, '', url.pathname + url.search);
      setView('chat');
      return;
    }

    // ?jobId=xxx&channelId=yyy params: open a specific job/channel (e.g. from SMS link)
    const jobIdParam = params.get('jobId');
    const channelIdParam = params.get('channelId');
    if (jobIdParam) {
      setJobId(jobIdParam);
      if (channelIdParam) setChannelId(channelIdParam);
      localStorage.setItem(STORAGE_KEY, jobIdParam);
      await loadConversationHistory(jobIdParam);
      // Strip params from URL
      const url = new URL(window.location.href);
      url.searchParams.delete('jobId');
      url.searchParams.delete('channelId');
      window.history.replaceState({}, '', url.pathname + url.search);
      setView('chat');
      return;
    }

    try {
      const res = await fetch('/api/v2/auth/session');
      if (res.ok) {
        const data = await res.json();
        if (data.authenticated && data.type === 'customer') {
          setCustomerId(data.customerId);
          setIsAuthenticated(true);
          setView('my_jobs');
          return;
        }
      }
    } catch {
      // Not authenticated — check localStorage
    }

    // Check localStorage for anonymous job
    const savedJobId = localStorage.getItem(STORAGE_KEY);
    if (savedJobId) {
      setJobId(savedJobId);
      await loadConversationHistory(savedJobId);
      setView('chat');
    } else {
      setView('chat');
    }
  };

  // ── Load conversation history for a job ──
  const loadConversationHistory = useCallback(async (loadJobId: string) => {
    try {
      const res = await fetch(`/api/v2/chat?jobId=${loadJobId}`);
      if (!res.ok) return;

      const data = await res.json();
      if (data.messages && data.messages.length > 0) {
        const loaded: ChatMessage[] = data.messages.map((m: any, i: number) => ({
          id: `loaded-${i}`,
          role: m.senderType === 'customer' ? 'user' as const : 'assistant' as const,
          content: m.content || m.rawContent || '',
          timestamp: m.createdAt || new Date().toISOString(),
        }));
        setMessages(loaded);
      }
    } catch {
      // Failed to load — start fresh
    }
  }, []);

  // ── Resume a job from MyJobsList ──
  const handleResumeJob = useCallback(async (resumeJobId: string) => {
    setJobId(resumeJobId);
    localStorage.setItem(STORAGE_KEY, resumeJobId);
    await loadConversationHistory(resumeJobId);
    setView('chat');
  }, [loadConversationHistory]);

  // ── Start a new enquiry ──
  const handleNewEnquiry = useCallback(() => {
    setJobId(null);
    localStorage.removeItem(STORAGE_KEY);
    setMessages([OPENING_MESSAGE]);
    setConversationPhase(null);
    setShowPhoneVerification(false);
    setView('chat');
  }, []);

  // ── Phone verified callback ──
  const handlePhoneVerified = useCallback((newCustomerId: string) => {
    setCustomerId(newCustomerId);
    setIsAuthenticated(true);
    setShowPhoneVerification(false);

    // Add a system message
    setMessages(prev => [...prev, {
      id: `verified-${Date.now()}`,
      role: 'assistant',
      content: "Phone verified — you're all set. You can come back to this conversation anytime.",
      timestamp: new Date().toISOString(),
    }]);
  }, []);

  // ── Show phone verification when bot asks for contact ──
  useEffect(() => {
    if (
      conversationPhase === 'providing_contact' &&
      !isAuthenticated &&
      !showPhoneVerification
    ) {
      setShowPhoneVerification(true);
    }
  }, [conversationPhase, isAuthenticated, showPhoneVerification]);

  // ── Voice input via Web Speech API ──
  const startListening = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Voice input is not supported in this browser. Try Chrome or Safari.');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-AU';

    recognition.onresult = (event: any) => {
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      setCurrentMessage(transcript);
    };

    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  };

  const stopListening = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsListening(false);
  };

  const toggleVoice = () => {
    if (isListening) stopListening();
    else startListening();
  };

  // Auto scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Handle photo upload
  const handlePhotoUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files) return;

    Array.from(files).forEach((file) => {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (e) => {
          const photo: Photo = {
            file,
            preview: e.target?.result as string,
            id: Date.now() + Math.random().toString(),
          };
          setPhotos(prev => [...prev, photo]);
        };
        reader.readAsDataURL(file);
      }
    });

    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removePhoto = (photoId: string) => {
    setPhotos(prev => prev.filter(p => p.id !== photoId));
  };

  // ── Send message via v2 chat API ──
  const sendMessage = async () => {
    if (!currentMessage.trim() && photos.length === 0) return;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: currentMessage,
      timestamp: new Date().toISOString(),
      photos: photos.length > 0 ? photos.map(p => ({ file: p.file, preview: p.preview })) : undefined,
    };

    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setCurrentMessage('');
    setPhotos([]);
    setIsLoading(true);

    try {
      // Upload photos first if any
      let photoUrls: string[] = [];
      if (userMessage.photos && userMessage.photos.length > 0) {
        try {
          const formData = new FormData();
          for (const p of userMessage.photos) {
            formData.append('photos', p.file);
          }
          if (jobId) formData.append('jobId', jobId);

          const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData });
          if (uploadRes.ok) {
            const uploadData = await uploadRes.json();
            photoUrls = uploadData.files?.map((f: { url: string }) => f.url) || [];
          }
        } catch {
          // Photo upload failed — continue without photos
          console.warn('Photo upload failed, continuing without photos');
        }
      }

      const conversationHistory = updatedMessages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: m.content }));

      const response = await fetch('/api/v2/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: currentMessage,
          messages: conversationHistory,
          messageType: photoUrls.length > 0 ? 'image' : 'text',
          ...(jobId ? { jobId } : {}),
          ...(channelId ? { channelId } : {}),
          ...(photoUrls.length > 0 ? { photos: photoUrls } : {}),
        }),
      });

      if (!response.ok) throw new Error('Failed to get response');

      const data = await response.json();

      // Track jobId — may change if a job pivot created a new job
      if (data.jobId) {
        setJobId(data.jobId);
        localStorage.setItem(STORAGE_KEY, data.jobId);
      }

      // Store auto-created channelId for subsequent messages
      if (data.channelId && !channelId) {
        setChannelId(data.channelId);
      }

      // Track conversation phase for triggering phone verification
      if (data.conversationPhase) {
        setConversationPhase(data.conversationPhase);
      }

      const assistantMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: data.reply,
        timestamp: new Date().toISOString(),
      };

      setMessages(prev => [...prev, assistantMessage]);
    } catch (error) {
      console.error('Error sending message:', error);
      const errorMessage: ChatMessage = {
        id: Date.now().toString(),
        role: 'assistant',
        content: "Sorry, I'm having trouble connecting right now. Please try again or call Todd directly.",
        timestamp: new Date().toISOString(),
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  // ── Render ──
  return (
    <div className="flex flex-col h-screen max-w-2xl mx-auto bg-gray-50">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white p-4 shadow-lg">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">Odd Job Todd</h1>
            <p className="text-sm text-blue-100">Professional Job Assessment Assistant</p>
          </div>
          {isAuthenticated && view === 'chat' && (
            <button
              onClick={() => setView('my_jobs')}
              className="text-xs text-blue-200 hover:text-white px-2 py-1 border border-blue-400 rounded"
            >
              My Enquiries
            </button>
          )}
        </div>
      </div>

      {/* Loading */}
      {view === 'loading' && (
        <div className="flex-1 flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* My Jobs view */}
      {view === 'my_jobs' && (
        <div className="flex-1 overflow-y-auto p-4">
          <MyJobsList onResumeJob={handleResumeJob} onNewEnquiry={handleNewEnquiry} />
        </div>
      )}

      {/* Chat view */}
      {view === 'chat' && (
        <>
          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-xs lg:max-w-md px-4 py-3 rounded-2xl shadow-sm ${
                    message.role === 'user'
                      ? 'bg-blue-600 text-white'
                      : 'bg-white text-gray-900 border border-gray-200'
                  }`}
                >
                  <p className="whitespace-pre-wrap">{message.content}</p>

                  {message.photos && (
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      {message.photos.map((photo, index) => (
                        <img
                          key={index}
                          src={photo.preview}
                          alt="Uploaded photo"
                          className="rounded w-full h-20 object-cover"
                        />
                      ))}
                    </div>
                  )}

                  <p className={`text-xs mt-2 ${
                    message.role === 'user' ? 'text-blue-200' : 'text-gray-500'
                  }`}>
                    {new Date(message.timestamp).toLocaleTimeString('en-AU', {
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12: false
                    })}
                  </p>
                </div>
              </div>
            ))}

            {/* Phone verification inline */}
            {showPhoneVerification && (
              <div className="flex justify-start">
                <div className="max-w-xs lg:max-w-md">
                  <PhoneVerification jobId={jobId} onVerified={handlePhoneVerified} />
                </div>
              </div>
            )}

            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-white text-gray-900 border border-gray-200 px-4 py-3 rounded-2xl shadow-sm">
                  <div className="flex items-center space-x-1">
                    <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce"></div>
                    <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                    <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Photo Preview */}
          {photos.length > 0 && (
            <div className="border-t border-gray-200 bg-white p-4">
              <div className="flex flex-wrap gap-3">
                {photos.map((photo) => (
                  <div key={photo.id} className="relative">
                    <img
                      src={photo.preview}
                      alt="Preview"
                      className="w-16 h-16 object-cover rounded-xl border-2 border-gray-200 shadow-sm"
                    />
                    <button
                      onClick={() => removePhoto(photo.id)}
                      className="absolute -top-2 -right-2 bg-red-500 hover:bg-red-600 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs shadow-md transition-colors"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Input */}
          <div className="border-t border-gray-200 bg-white p-4 shadow-lg">
            <div className="flex space-x-3 items-end">
              <input
                type="file"
                ref={fileInputRef}
                onChange={handlePhotoUpload}
                accept="image/*"
                multiple
                className="hidden"
              />

              <button
                onClick={() => fileInputRef.current?.click()}
                className="p-3 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded-xl transition-all duration-200"
                title="Add photos"
              >
                <Camera className="w-5 h-5" />
              </button>

              <button
                onClick={toggleVoice}
                className={`p-3 rounded-xl transition-all duration-200 ${
                  isListening
                    ? 'text-red-600 bg-red-50 animate-pulse'
                    : 'text-gray-500 hover:text-blue-600 hover:bg-blue-50'
                }`}
                title={isListening ? 'Stop recording' : 'Voice input'}
              >
                {isListening ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
              </button>

              <input
                type="text"
                value={currentMessage}
                onChange={(e) => setCurrentMessage(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                placeholder="Describe your job in detail..."
                className="flex-1 border border-gray-300 rounded-xl px-4 py-3 bg-gray-50 text-gray-900 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 focus:bg-white transition-all duration-200"
              />

              <button
                onClick={sendMessage}
                disabled={isLoading || (!currentMessage.trim() && photos.length === 0)}
                className="bg-gradient-to-r from-blue-600 to-blue-700 text-white px-6 py-3 rounded-xl hover:from-blue-700 hover:to-blue-800 disabled:opacity-50 transition-all duration-200 shadow-sm font-medium"
              >
                <Send className="w-5 h-5" />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
