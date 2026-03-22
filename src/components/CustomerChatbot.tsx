'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Send, Upload, X, Camera, Mic, MicOff } from 'lucide-react';
import { ChatMessage } from '@/types/job';

interface Photo {
  file: File;
  preview: string;
  id: string;
}

export default function CustomerChatbot() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: '1',
      role: 'assistant',
      content: "G'day! I'm Todd's AI assistant. I'm here to help Todd understand your job properly so he can tell you whether he can help.\n\nWhat do you need done? You can type, send photos, or press the mic and talk me through it.",
      timestamp: new Date().toISOString(),
    },
  ]);
  const [currentMessage, setCurrentMessage] = useState('');
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [isListening, setIsListening] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);

  // ── Voice input via Web Speech API ──────────
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

    recognition.onerror = (event: any) => {
      console.error('Speech recognition error:', event.error);
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

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
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  };

  // Auto scroll to bottom when new messages arrive
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

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Remove photo
  const removePhoto = (photoId: string) => {
    setPhotos(prev => prev.filter(p => p.id !== photoId));
  };

  // Send message via v2 chat API
  const sendMessage = async () => {
    if (!currentMessage.trim() && photos.length === 0) return;

    // Add user message
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
      // Build conversation history for the v2 API (stateless fallback needs this)
      const conversationHistory = updatedMessages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: m.content }));

      const response = await fetch('/api/v2/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: currentMessage,
          messages: conversationHistory,
          messageType: 'text',
          ...(jobId ? { jobId } : {}),
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to get response');
      }

      const data = await response.json();

      // Track jobId for subsequent messages (full pipeline mode)
      if (data.jobId && !jobId) {
        setJobId(data.jobId);
      }

      // Add assistant response
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

  return (
    <div className="flex flex-col h-screen max-w-2xl mx-auto bg-gray-50">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white p-4 shadow-lg">
        <h1 className="text-xl font-bold">Odd Job Todd</h1>
        <p className="text-sm text-blue-100">Professional Job Assessment Assistant</p>
      </div>

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
    </div>
  );
}