'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Send, Upload, X, Camera } from 'lucide-react';
import { ChatMessage, JobSheet } from '@/types/job';
import { createJobSheet } from '@/lib/jobService';

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
      content: "G'day! I'm Todd's AI assistant. I'm here to help Todd understand your job properly so he can tell you whether he can help.\n\nI'll ask you some questions to get all the details Todd needs. This way, Todd can quickly review your job and let you know if he's the right person for what you need.\n\nWhat do you need help with today?",
      timestamp: new Date().toISOString(),
    },
  ]);
  const [currentMessage, setCurrentMessage] = useState('');
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showJobSheet, setShowJobSheet] = useState(false);
  const [jobSheetData, setJobSheetData] = useState<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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

  // Extract job sheet data from conversation
  const extractJobSheetData = (conversation: ChatMessage[]) => {
    const conversationText = conversation
      .map(m => `${m.role}: ${m.content}`)
      .join('\n\n');

    // Extract user messages only (their actual requirements)
    const userMessages = conversation
      .filter(m => m.role === 'user')
      .map(m => m.content)
      .join(' ');

    // Enhanced extraction with better patterns and fallbacks
    const extractField = (pattern: RegExp, fallback = '') => {
      const match = conversationText.match(pattern);
      return match ? match[1].trim() : fallback;
    };

    const extractMultipleFields = (patterns: RegExp[]) => {
      for (const pattern of patterns) {
        const match = conversationText.match(pattern);
        if (match) return match[1].trim();
      }
      return '';
    };

    // Extract customer name with improved patterns
    const customerName = extractMultipleFields([
      // Direct name statements
      /(?:my\s+)?name\s+is\s+([A-Za-z\s]+?)(?:\s*,|\s*\.|$|phone|email)/i,
      /(?:I'm|I am)\s+([A-Za-z\s]+?)(?:\s*,|\s*\.|$|phone|email)/i,
      // Pattern: "name <name>, phone <phone>"
      /name\s+([A-Za-z\s]+?),\s*phone/i,
      // Look for proper names in conversation (First Last format)
      /(?:^|user:|assistant:).*?([A-Z][a-z]+\s+[A-Z][a-z]+)(?:\s*,|\s*\.|$)/m,
      // Fallback to any capitalized name pattern
      /([A-Z][a-z]{2,}\s+[A-Z][a-z]{2,})/
    ]) || 'Unknown Customer';

    // Clean up extracted name
    const cleanName = customerName
      .replace(/^\w+:\s*/, '') // Remove "user:" or "assistant:" prefixes
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();

    // Extract job type and create better title using improved logic
    const jobKeywords = userMessages.toLowerCase();
    let jobTitle = 'General Handyman Job';
    let category: JobSheet['job']['category'] = 'general';
    let subcategory = '';

    // Enhanced job detection with subcategories
    if (jobKeywords.includes('door')) {
      jobTitle = jobKeywords.includes('replace') ? 'Door Replacement' : 'Door Repair';
      category = 'doors_windows';
      subcategory = 'door_replacement';
    } else if (jobKeywords.includes('window')) {
      jobTitle = 'Window Repair/Replacement';
      category = 'doors_windows';
      subcategory = 'window_repair';
    } else if (jobKeywords.includes('deck')) {
      if (jobKeywords.includes('build') || jobKeywords.includes('construct')) {
        jobTitle = 'Deck Construction';
        subcategory = 'deck_construction';
      } else {
        jobTitle = 'Deck Repair';
        subcategory = 'deck_repair';
      }
      category = 'carpentry';
    } else if (jobKeywords.includes('fence') || jobKeywords.includes('gate')) {
      jobTitle = 'Fencing Work';
      category = 'fencing';
      subcategory = 'fence_repair';
    } else if (jobKeywords.includes('paint')) {
      jobTitle = 'Painting Work';
      category = 'painting';
      subcategory = jobKeywords.includes('exterior') ? 'exterior_painting' : 'interior_painting';
    } else if (jobKeywords.includes('shelf') || jobKeywords.includes('storage')) {
      jobTitle = 'Storage/Shelving';
      category = 'carpentry';
      subcategory = 'shelving';
    } else if (jobKeywords.includes('tap') || jobKeywords.includes('leak') || jobKeywords.includes('plumb')) {
      jobTitle = 'Plumbing Work';
      category = 'plumbing';
      subcategory = 'tap_repair';
    } else if (jobKeywords.includes('tile')) {
      jobTitle = 'Tiling Work';
      category = 'tiling';
      subcategory = 'tile_repair';
    } else if (jobKeywords.includes('roof')) {
      jobTitle = 'Roofing Work';
      category = 'roofing';
      subcategory = 'roof_repair';
    }

    // Extract job description (clean summary, not full conversation)
    const jobDescription = extractJobDescription(userMessages, conversationText);

    // Extract urgency with improved patterns
    const urgencyText = conversationText.toLowerCase();
    let urgency: JobSheet['job']['urgency'] = 'unspecified';

    if (urgencyText.includes('emergency') || urgencyText.includes('urgent emergency')) {
      urgency = 'emergency';
    } else if (urgencyText.includes('asap') || urgencyText.includes('urgent') || urgencyText.includes('immediate')) {
      urgency = 'urgent';
    } else if (urgencyText.includes('next week') || urgencyText.includes('within a week')) {
      urgency = 'next_week';
    } else if (urgencyText.includes('next 2 weeks') || urgencyText.includes('couple of weeks') || urgencyText.includes('fortnight')) {
      urgency = 'next_2_weeks';
    } else if (urgencyText.includes('flexible') || urgencyText.includes('no rush') || urgencyText.includes('whenever')) {
      urgency = 'flexible';
    } else if (urgencyText.includes('when convenient') || urgencyText.includes('when you can')) {
      urgency = 'when_convenient';
    }

    // Enhanced location extraction with postcode detection
    const extractLocationData = (text: string) => {
      const location = extractMultipleFields([
        /(?:in|from|at|location:?)\s+([A-Za-z\s]+?)(?:\s*,|\s*\.|$)/i,
        /suburb:?\s*([A-Za-z\s]+)/i,
        /([A-Za-z\s]+)\s+(\d{4})/,
        /(?:address|live|located)\s+.*?([A-Za-z\s]+?)(?:\s*,|\s*\.|$)/i
      ]) || 'Location not specified';

      // Extract postcode if present
      const postcodeMatch = text.match(/\b(\d{4})\b/);
      const postcode = postcodeMatch ? postcodeMatch[1] : undefined;

      // Extract state if present
      const stateMatch = text.match(/\b(QLD|NSW|VIC|TAS|SA|WA|NT|ACT)\b/i);
      const state = stateMatch ? stateMatch[1].toUpperCase() : undefined;

      return { location: location.trim(), postcode, state };
    };

    const locationData = extractLocationData(conversationText);

    // Calculate AI confidence scores
    const extractionConfidence = calculateExtractionConfidence(cleanName, conversationText, locationData);

    // Generate cost estimate
    const costEstimate = generateCostEstimate(category, subcategory, jobDescription, urgency);

    return {
      jobId: '', // Will be set by Firebase
      status: 'new' as const,
      createdAt: new Date().toISOString(),
      reviewed: false, // Legacy field

      customer: {
        name: cleanName,
        phone: extractField(/((?:\+61|0)[4-9]\d{8})/) || '',
        email: extractField(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/) || '',
        location: {
          suburb: locationData.location || 'Unknown',
          postcode: locationData.postcode || '',
          state: locationData.state || '',
          // distanceFromBase and coordinates will be calculated by geocoding service
        }
      },

      job: {
        title: jobTitle,
        description: jobDescription,
        category: category,
        subcategory: subcategory || undefined,
        urgency: urgency,
        location: jobKeywords.includes('outdoor') ? 'outdoor' :
                 jobKeywords.includes('indoor') ? 'indoor' : 'both',

        materials: {
          surface: extractMultipleFields([
            /(timber|brick|metal|plaster|wood|steel|concrete|hollow core)/i,
            /(?:made of|material)\s+([A-Za-z\s]+)/i
          ]) || '',
          condition: extractMultipleFields([
            /(rotten|damaged|old|broken|worn|cracked)/i,
            /(?:condition|state)\s+([A-Za-z\s]+)/i
          ]) || '',
          measurements: extractField(/(\d+[mx\s\d]+)/i) || '',
          access: extractMultipleFields([
            /(ground_level|easy access|difficult access)/i,
            /(?:access|parking)\s+([^.]+)/i
          ]) === 'difficult access' ? 'difficult_access' : 'ground_level',
          customerSupplying: extractCustomerSupplying(conversationText) || [],
          type: extractMultipleFields([ // Legacy field
            /(timber|brick|metal|plaster|wood|steel|concrete|hollow core)/i
          ]) || ''
        },

        context: {
          historyNotes: extractMultipleFields([
            /(?:problem|issue|damage)\s+([^.]+)/i,
            /(getting worse|been happening|started)/i
          ]) || '',
          accessNotes: extractField(/(?:access|parking)(?:\s+is)?\s+([^.]+)/i) || '',
          equipmentNeeded: extractEquipmentNeeded(subcategory, conversationText) || [],
          skillLevel: determineSkillLevel(category, subcategory, conversationText) || 'skilled_handyman',
          problemHistory: extractMultipleFields([ // Legacy field
            /(?:problem|issue|damage)\s+([^.]+)/i
          ]) || ''
        }
      },

      // Cost estimation
      estimate: costEstimate,

      photos: photos.map(p => ({
        url: p.preview,
        type: 'context' as const,
        caption: 'Customer uploaded photo',
        timestamp: new Date().toISOString()
      })),

      // AI metadata
      aiAnalysis: {
        extractionConfidence: extractionConfidence || 0.5,
        locationConfidence: locationData.postcode ? 0.9 : 0.6,
        flaggedForReview: extractionConfidence < 0.7 ? 'Low extraction confidence' : '',
        suggestedActions: generateSuggestedActions(cleanName, urgency, subcategory) || []
      },

      // Store conversation for reference
      conversationData: {
        summary: generateConversationSummary(userMessages, jobTitle) || 'Job conversation'
      },
      conversationText: conversationText || '', // Legacy field
    };
  };

  // Helper function to extract clean job description
  const extractJobDescription = (userMessages: string, fullConversation: string): string => {
    // Try to find the main job description from user messages
    const cleanUserText = userMessages
      .replace(/(?:name|I'm|I am)\s+[A-Za-z\s]+/gi, '') // Remove name
      .replace(/(?:\+61|0)[4-9]\d{8}/g, '') // Remove phone
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '') // Remove email
      .replace(/\s+/g, ' ')
      .trim();

    // If user messages are too short, try to extract from AI summary
    if (cleanUserText.length < 50) {
      const summaryMatch = fullConversation.match(/\*\*Job Summary:\*\*\s*([^*]+)/);
      if (summaryMatch) {
        return summaryMatch[1].trim();
      }
    }

    return cleanUserText || 'Job details provided in conversation';
  };

  // Helper function to extract what customer is supplying
  const extractCustomerSupplying = (text: string): string[] => {
    const supplying: string[] = [];
    const supplyingText = text.toLowerCase();

    if (supplyingText.includes('customer supply') || supplyingText.includes('i have') || supplyingText.includes('supplying')) {
      if (supplyingText.includes('hinges')) supplying.push('hinges');
      if (supplyingText.includes('door furniture') || supplyingText.includes('handles')) supplying.push('door furniture');
      if (supplyingText.includes('paint')) supplying.push('paint');
      if (supplyingText.includes('materials')) supplying.push('materials');
    }

    return supplying;
  };

  // Helper function to extract equipment needed
  const extractEquipmentNeeded = (subcategory: string, text: string): string[] => {
    const equipment: string[] = [];

    // Use predefined equipment mappings
    if (subcategory === 'door_replacement') {
      return ['drill', 'screwdriver', 'chisel', 'level'];
    } else if (subcategory === 'deck_repair') {
      return ['saw', 'drill', 'hammer', 'level', 'measuring_tape'];
    }

    // Parse from conversation
    const equipmentText = text.toLowerCase();
    if (equipmentText.includes('ladder')) equipment.push('ladder');
    if (equipmentText.includes('scaffolding')) equipment.push('scaffolding');
    if (equipmentText.includes('saw')) equipment.push('saw');
    if (equipmentText.includes('drill')) equipment.push('drill');

    return equipment.length > 0 ? equipment : ['basic tools'];
  };

  // Helper function to determine skill level required
  const determineSkillLevel = (category: string, subcategory: string, text: string): JobSheet['job']['context']['skillLevel'] => {
    const complexKeywords = ['electrical', 'plumbing', 'structural', 'permit', 'certified'];
    const simpleKeywords = ['basic', 'simple', 'straightforward', 'easy'];

    const textLower = text.toLowerCase();

    if (complexKeywords.some(keyword => textLower.includes(keyword))) {
      return 'specialist_required';
    } else if (category === 'electrical' || category === 'plumbing') {
      return 'specialist_required';
    } else if (simpleKeywords.some(keyword => textLower.includes(keyword))) {
      return 'basic_handyman';
    }

    return 'skilled_handyman';
  };

  // Helper function to calculate extraction confidence
  const calculateExtractionConfidence = (name: string, conversation: string, locationData: any): number => {
    let confidence = 0.5; // Base confidence

    // Name confidence
    if (name !== 'Unknown Customer' && name.includes(' ')) confidence += 0.2;

    // Contact info confidence
    if (conversation.includes('@')) confidence += 0.1;
    if (conversation.match(/\d{10}/)) confidence += 0.1;

    // Location confidence
    if (locationData.postcode) confidence += 0.1;
    if (locationData.location !== 'Location not specified') confidence += 0.1;

    return Math.min(confidence, 1.0);
  };

  // Helper function to generate suggested actions
  const generateSuggestedActions = (name: string, urgency: string, subcategory: string): string[] => {
    const actions: string[] = [];

    if (name === 'Unknown Customer') actions.push('Verify customer name');
    if (urgency === 'emergency') actions.push('Contact immediately');
    if (urgency === 'urgent') actions.push('Priority review required');
    if (subcategory === 'door_replacement') actions.push('Check door measurements');

    return actions;
  };

  // Helper function to generate conversation summary
  const generateConversationSummary = (userMessages: string, jobTitle: string): string => {
    const summary = userMessages.substring(0, 200);
    return `${jobTitle} - ${summary}${summary.length >= 200 ? '...' : ''}`;
  };

  // Helper function to generate cost estimates
  const generateCostEstimate = (category: string, subcategory: string, description: string, urgency: string): JobSheet['estimate'] => {
    const baseRates = {
      'basic_handyman': 80,
      'skilled_handyman': 120,
      'specialist': 150,
      'subcontract': 200
    };

    let tier: NonNullable<JobSheet['estimate']>['tier'] = 'skilled_handyman';
    let estimatedHours = { min: 2, max: 4 };
    let materialsEstimate = 100;
    let confidence: 'low' | 'medium' | 'high' = 'medium';
    let notes = '';

    // Determine tier and estimates based on job type
    switch (subcategory) {
      case 'door_replacement':
        tier = 'skilled_handyman';
        estimatedHours = { min: 3, max: 6 };
        materialsEstimate = extractMaterialsCost(description, 'door');
        confidence = 'high';
        notes = 'Standard door replacement, may need inspection for frame condition';
        break;

      case 'deck_repair':
        tier = 'skilled_handyman';
        estimatedHours = { min: 4, max: 8 };
        materialsEstimate = extractMaterialsCost(description, 'deck');
        confidence = 'medium';
        notes = 'Deck work varies greatly, inspection recommended';
        break;

      case 'deck_construction':
        tier = 'specialist';
        estimatedHours = { min: 16, max: 40 };
        materialsEstimate = 2000;
        confidence = 'low';
        notes = 'Major construction project, requires detailed quote after site inspection';
        break;

      case 'fence_repair':
        tier = 'skilled_handyman';
        estimatedHours = { min: 3, max: 6 };
        materialsEstimate = extractMaterialsCost(description, 'fence');
        confidence = 'medium';
        break;

      case 'interior_painting':
        tier = 'skilled_handyman';
        estimatedHours = extractPaintingHours(description);
        materialsEstimate = Math.floor(estimatedHours.max * 15); // $15 per hour in paint
        confidence = 'high';
        break;

      case 'tap_repair':
        tier = 'specialist';
        estimatedHours = { min: 1, max: 3 };
        materialsEstimate = 50;
        confidence = 'medium';
        notes = 'Plumbing work, licensed tradesman required';
        break;

      default:
        tier = 'skilled_handyman';
        estimatedHours = { min: 2, max: 5 };
        materialsEstimate = 100;
        confidence = 'low';
        notes = 'General estimate, inspection recommended for accurate quote';
    }

    // Adjust for urgency
    if (urgency === 'emergency' || urgency === 'urgent') {
      estimatedHours.min *= 1.2;
      estimatedHours.max *= 1.2;
      notes += ' Urgent job - priority pricing may apply';
    }

    const hourlyRate = baseRates[tier];
    const estimatedCost = {
      min: Math.floor(estimatedHours.min * hourlyRate),
      max: Math.floor(estimatedHours.max * hourlyRate)
    };
    const totalEstimate = {
      min: estimatedCost.min + materialsEstimate,
      max: estimatedCost.max + materialsEstimate
    };

    return {
      tier,
      hourlyRate,
      estimatedHours,
      estimatedCost,
      materialsEstimate,
      totalEstimate,
      confidence,
      notes,
      needsInspection: confidence === 'low' || category === 'electrical' || category === 'plumbing'
    };
  };

  // Helper to extract materials cost from description
  const extractMaterialsCost = (description: string, jobType: string): number => {
    const desc = description.toLowerCase();

    if (jobType === 'door') {
      if (desc.includes('3 door')) return 450; // 3 doors * ~$150 each
      if (desc.includes('2 door')) return 300;
      return 150; // Single door
    }

    if (jobType === 'deck') {
      if (desc.includes('board')) {
        const boardMatch = desc.match(/(\d+)[^\d]*board/);
        if (boardMatch) {
          return parseInt(boardMatch[1]) * 25; // $25 per board
        }
      }
      return 200; // Default deck materials
    }

    if (jobType === 'fence') {
      if (desc.includes('post')) return 100;
      if (desc.includes('panel')) return 150;
      return 80;
    }

    return 100; // Default materials cost
  };

  // Helper to extract painting hours from description
  const extractPaintingHours = (description: string): { min: number; max: number } => {
    const desc = description.toLowerCase();

    // Look for room count or size indicators
    if (desc.includes('3 door') || desc.includes('room')) {
      return { min: 4, max: 8 };
    }
    if (desc.includes('wall') || desc.includes('ceiling')) {
      return { min: 3, max: 6 };
    }

    return { min: 2, max: 4 }; // Default painting time
  };

  // Send message
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
      // Send to Claude API
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: updatedMessages.map(m => ({
            role: m.role,
            content: m.content,
          })),
          photos: photos.length > 0 ? photos.map(p => p.preview) : undefined,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to get response');
      }

      const data = await response.json();

      // Add assistant response
      const assistantMessage: ChatMessage = {
        id: Date.now().toString(),
        role: 'assistant',
        content: data.message,
        timestamp: new Date().toISOString(),
      };

      setMessages(prev => [...prev, assistantMessage]);

      // Check if conversation seems complete (contains contact details)
      const hasName = updatedMessages.some(m => m.content.toLowerCase().includes('name'));
      const hasContact = updatedMessages.some(m =>
        m.content.includes('@') || m.content.match(/\d{10}/)
      );

      if (hasName && hasContact && updatedMessages.length > 6) {
        // Show job sheet completion option
        setJobSheetData(extractJobSheetData([...updatedMessages, assistantMessage]));
        setTimeout(() => setShowJobSheet(true), 2000);
      }
    } catch (error) {
      console.error('Error sending message:', error);
      const errorMessage: ChatMessage = {
        id: Date.now().toString(),
        role: 'assistant',
        content: "Sorry, I'm having trouble connecting right now. Please try again or call Todd directly at your number.",
        timestamp: new Date().toISOString(),
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  // Submit job sheet
  const submitJobSheet = async () => {
    if (!jobSheetData) return;

    try {
      setIsLoading(true);
      const jobId = await createJobSheet(jobSheetData);

      // Show success message
      const successMessage: ChatMessage = {
        id: Date.now().toString(),
        role: 'assistant',
        content: `Perfect! Your job details (#${jobId}) have been sent to Todd. He'll review everything and get back to you at ${jobSheetData.customer.email} to let you know if he can help. Thanks for taking the time to provide proper details!`,
        timestamp: new Date().toISOString(),
      };
      setMessages(prev => [...prev, successMessage]);
      setShowJobSheet(false);
    } catch (error) {
      console.error('Error submitting job sheet:', error);
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

      {/* Job Sheet Preview */}
      {showJobSheet && jobSheetData && (
        <div className="bg-gradient-to-r from-emerald-50 to-green-50 border-t border-emerald-200 p-4 shadow-inner">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-emerald-800">✓ Ready to Send Job Details?</h3>
            <button
              onClick={() => setShowJobSheet(false)}
              className="text-emerald-600 hover:text-emerald-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <p className="text-sm text-emerald-700 mb-4 leading-relaxed">
            Todd will review: job description, {jobSheetData.photos.length} photo(s), and your contact details
          </p>
          <button
            onClick={submitJobSheet}
            disabled={isLoading}
            className="w-full bg-gradient-to-r from-emerald-600 to-green-600 text-white py-3 px-4 rounded-xl hover:from-emerald-700 hover:to-green-700 disabled:opacity-50 transition-all duration-200 font-medium shadow-sm"
          >
            Send Job Details to Todd
          </button>
        </div>
      )}

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