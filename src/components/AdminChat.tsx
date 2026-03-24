'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Camera, Mic, MicOff, ArrowLeft, X } from 'lucide-react';

// ── Types ───────────────────────────────────

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  photos?: string[];
  toolResults?: Array<{ tool: string; result: any }>;
  timestamp: string;
}

interface Photo {
  file: File;
  preview: string;
  id: string;
}

// ── Component ───────────────────────────────

export default function AdminChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([{
    id: '1',
    role: 'assistant',
    content: "G'day boss. What do you need?",
    timestamp: new Date().toISOString(),
  }]);
  const [currentMessage, setCurrentMessage] = useState('');
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── Send message ──

  const sendMessage = useCallback(async () => {
    const text = currentMessage.trim();
    if (!text && photos.length === 0) return;
    if (isLoading) return;

    setIsLoading(true);
    setCurrentMessage('');

    // Upload photos first if any
    let photoUrls: string[] = [];
    if (photos.length > 0) {
      try {
        const formData = new FormData();
        photos.forEach((p) => formData.append('photos', p.file));
        formData.append('jobId', activeJobId || 'admin-upload');

        const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData });
        if (uploadRes.ok) {
          const uploadData = await uploadRes.json();
          photoUrls = uploadData.files.map((f: any) => f.url);
        }
      } catch {
        // Upload failed — continue without photos
      }
      setPhotos([]);
    }

    // Add user message
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      photos: photoUrls.length > 0 ? photoUrls : undefined,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);

    try {
      // Build history from previous messages (last 20)
      const history = messages.slice(-20).map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const res = await fetch('/api/v2/admin/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text + (photoUrls.length ? `\n[${photoUrls.length} photo(s) uploaded]` : ''),
          photos: photoUrls.length > 0 ? photoUrls : undefined,
          jobContext: activeJobId || undefined,
          history,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed' }));
        throw new Error(err.error || `Error ${res.status}`);
      }

      const data = await res.json();

      // Track job context from tool results
      if (data.toolResults?.length) {
        for (const tr of data.toolResults) {
          if (tr.tool === 'get_job_detail' && tr.result?.id) {
            setActiveJobId(tr.result.id);
          }
          if (tr.tool === 'search_jobs' && tr.result?.jobs?.length === 1) {
            setActiveJobId(tr.result.jobs[0].id);
          }
        }
      }

      const aiMsg: ChatMessage = {
        id: `ai-${Date.now()}`,
        role: 'assistant',
        content: data.reply,
        toolResults: data.toolResults,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, aiMsg]);
    } catch (err) {
      const errorMsg: ChatMessage = {
        id: `err-${Date.now()}`,
        role: 'assistant',
        content: `Sorry, something went wrong: ${err instanceof Error ? err.message : 'Unknown error'}`,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
    }
  }, [currentMessage, photos, isLoading, messages, activeJobId]);

  // ── Photo handling ──

  function handlePhotoSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    const newPhotos = files.slice(0, 5 - photos.length).map((file) => ({
      file,
      preview: URL.createObjectURL(file),
      id: `${Date.now()}-${Math.random()}`,
    }));
    setPhotos((prev) => [...prev, ...newPhotos]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function removePhoto(id: string) {
    setPhotos((prev) => {
      const photo = prev.find((p) => p.id === id);
      if (photo) URL.revokeObjectURL(photo.preview);
      return prev.filter((p) => p.id !== id);
    });
  }

  // ── Voice input ──

  function toggleVoice() {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.lang = 'en-AU';
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event: any) => {
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      setCurrentMessage(transcript);
    };

    recognition.onend = () => setIsListening(false);
    recognition.onerror = () => setIsListening(false);

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  }

  // ── Key handler ──

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  // ── Render ──

  return (
    <div className="flex flex-col h-[100dvh] bg-gray-50">
      {/* Header */}
      <div className="bg-gradient-to-r from-amber-600 to-amber-700 text-white px-4 py-3 shadow-md flex items-center gap-3">
        <a href="/admin/leads" className="hover:opacity-80">
          <ArrowLeft className="w-5 h-5" />
        </a>
        <div className="flex-1">
          <h1 className="font-bold text-lg leading-tight">Todd&apos;s Copilot</h1>
          <p className="text-amber-200 text-xs">Job management assistant</p>
        </div>
        {activeJobId && (
          <button
            onClick={() => setActiveJobId(null)}
            className="flex items-center gap-1 bg-amber-800/40 px-2 py-1 rounded-full text-xs"
          >
            Job focused <X className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 ${
                msg.role === 'user'
                  ? 'bg-amber-600 text-white rounded-br-md'
                  : 'bg-white border border-gray-200 text-gray-800 rounded-bl-md shadow-sm'
              }`}
            >
              {/* Photos */}
              {msg.photos && msg.photos.length > 0 && (
                <div className="grid grid-cols-2 gap-1 mb-2">
                  {msg.photos.map((url, i) => (
                    <img key={i} src={url} alt="" className="w-full h-20 object-cover rounded-lg" />
                  ))}
                </div>
              )}

              {/* Text */}
              <p className="text-sm whitespace-pre-wrap">{msg.content}</p>

              {/* Tool result cards */}
              {msg.toolResults?.map((tr, i) => (
                <ToolResultCard key={i} tool={tr.tool} result={tr.result} />
              ))}

              {/* Timestamp */}
              <p className={`text-[10px] mt-1 ${msg.role === 'user' ? 'text-amber-200' : 'text-gray-400'}`}>
                {new Date(msg.timestamp).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-white border border-gray-200 rounded-2xl rounded-bl-md px-4 py-3 shadow-sm">
              <div className="flex gap-1">
                <div className="w-2 h-2 bg-amber-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-2 h-2 bg-amber-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-2 h-2 bg-amber-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Photo preview strip */}
      {photos.length > 0 && (
        <div className="px-4 py-2 bg-white border-t flex gap-2 overflow-x-auto">
          {photos.map((photo) => (
            <div key={photo.id} className="relative flex-shrink-0">
              <img src={photo.preview} alt="" className="w-16 h-16 object-cover rounded-xl" />
              <button
                onClick={() => removePhoto(photo.id)}
                className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input bar */}
      <div className="bg-white border-t px-3 py-3 flex items-end gap-2" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="p-2 text-gray-400 hover:text-amber-600 transition"
        >
          <Camera className="w-5 h-5" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          className="hidden"
          onChange={handlePhotoSelect}
        />

        <button
          onClick={toggleVoice}
          className={`p-2 transition ${isListening ? 'text-red-500' : 'text-gray-400 hover:text-amber-600'}`}
        >
          {isListening ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
        </button>

        <textarea
          ref={inputRef}
          value={currentMessage}
          onChange={(e) => setCurrentMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about jobs, add notes..."
          rows={1}
          className="flex-1 resize-none border border-gray-300 rounded-xl px-3 py-2 text-sm focus:ring-2 focus:ring-amber-500 focus:border-amber-500 outline-none"
          style={{ maxHeight: '120px' }}
        />

        <button
          onClick={sendMessage}
          disabled={isLoading || (!currentMessage.trim() && photos.length === 0)}
          className="p-2.5 bg-amber-600 text-white rounded-xl hover:bg-amber-700 disabled:opacity-40 transition"
        >
          <Send className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}

// ── Tool Result Cards ──

function ToolResultCard({ tool, result }: { tool: string; result: any }) {
  if (result?.error) {
    return (
      <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
        Error: {result.error}
      </div>
    );
  }

  switch (tool) {
    case 'search_jobs':
      return (
        <div className="mt-2 space-y-1">
          {result?.jobs?.map((job: any) => (
            <div key={job.id} className="p-2 bg-gray-50 rounded-lg text-xs flex justify-between items-center">
              <div>
                <span className="font-medium">{job.jobType}</span>
                {job.suburb && <span className="text-gray-500"> — {job.suburb}</span>}
                {job.customerName && <span className="text-gray-400"> ({job.customerName})</span>}
              </div>
              <div className="flex items-center gap-2">
                {job.costRange && <span className="text-green-700">{job.costRange}</span>}
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  job.status === 'partial_intake' ? 'bg-yellow-100 text-yellow-700' :
                  job.status === 'awaiting_customer' ? 'bg-blue-100 text-blue-700' :
                  job.status === 'needs_site_visit' ? 'bg-orange-100 text-orange-700' :
                  job.status === 'scheduled' ? 'bg-green-100 text-green-700' :
                  'bg-gray-100 text-gray-600'
                }`}>
                  {job.status?.replace(/_/g, ' ')}
                </span>
              </div>
            </div>
          ))}
          {result?.count === 0 && <p className="text-xs text-gray-400">No jobs found.</p>}
        </div>
      );

    case 'add_job_note':
    case 'add_job_photos':
    case 'update_job_estimate':
    case 'update_job_status':
      return result?.success ? (
        <div className="mt-2 p-2 bg-green-50 border border-green-200 rounded-lg text-xs text-green-700 flex items-center gap-1">
          ✓ Done
        </div>
      ) : null;

    case 'generate_formal_quote':
      return result?.quoteText ? (
        <div className="mt-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <pre className="text-xs text-gray-700 whitespace-pre-wrap font-mono">{result.quoteText}</pre>
        </div>
      ) : null;

    default:
      return null;
  }
}
