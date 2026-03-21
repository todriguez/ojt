import { NextRequest, NextResponse } from 'next/server';
import { collection, getDocs, query, where, addDoc, updateDoc, doc } from 'firebase/firestore';
import { getFirebaseDb } from '@/lib/firebase';
import { createJobSheet } from '@/lib/jobService';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

const ANALYSIS_PROMPT = `You are an AI agent that extracts job information from incomplete customer service conversations.

Your task is to analyze conversation text and extract as much useful information as possible, even from partial or incomplete conversations.

EXTRACT THE FOLLOWING INFORMATION:
1. Job Description: What work needs to be done?
2. Customer Name: Any name mentioned
3. Contact Details: Phone, email if mentioned
4. Location: Suburb, address details
5. Urgency Level: How urgent is the job?
6. Materials/Size: What materials or dimensions mentioned?
7. Job Type: What category of work is this?

RETURN A JSON OBJECT with these fields:
{
  "jobDescription": "string",
  "customerName": "string or null",
  "phone": "string or null",
  "email": "string or null",
  "suburb": "string or null",
  "urgencyLevel": "emergency|urgent|next_week|next_2_weeks|flexible|when_convenient|unspecified",
  "materials": "string describing materials mentioned",
  "dimensions": "string describing size/dimensions",
  "jobCategory": "doors_windows|carpentry|painting|plumbing|electrical|fencing|general",
  "hasEnoughInfo": boolean,
  "missingInfo": "string describing what key info is missing",
  "conversationQuality": "complete|partial|minimal"
}

Be generous in extraction - even partial information is valuable. If name/contact is missing, still extract the job details.`;

// Conversations collection (we'll store incomplete conversations here)
function getConversationsCollection() {
  return collection(getFirebaseDb(), 'conversations');
}

export async function POST(request: NextRequest) {
  try {
    console.log('Starting conversation analysis...');

    // Get all unprocessed conversations
    const q = query(getConversationsCollection(), where('processed', '==', false));
    const querySnapshot = await getDocs(q);

    const processedCount = { total: 0, created: 0, errors: 0 };

    for (const conversationDoc of querySnapshot.docs) {
      const conversationData = conversationDoc.data();
      processedCount.total++;

      try {
        console.log(`Processing conversation ${conversationDoc.id}...`);

        // Analyze conversation with Claude
        const analysisResponse = await anthropic.messages.create({
          model: 'claude-3-5-sonnet-20240620',
          max_tokens: 1000,
          system: ANALYSIS_PROMPT,
          messages: [{
            role: 'user',
            content: `Analyze this customer conversation and extract job information:\n\n${conversationData.conversationText}`
          }],
        });

        const analysisText = analysisResponse.content[0].type === 'text'
          ? analysisResponse.content[0].text
          : '';

        // Parse the JSON response
        let analysis;
        try {
          // Extract JSON from the response
          const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            analysis = JSON.parse(jsonMatch[0]);
          } else {
            throw new Error('No JSON found in analysis response');
          }
        } catch (parseError) {
          console.error('Failed to parse analysis JSON:', parseError);
          continue;
        }

        // Create job sheet if we have enough information
        if (analysis.hasEnoughInfo || analysis.jobDescription.length > 10) {
          const jobSheetData = createJobSheetFromAnalysis(analysis, conversationData);

          try {
            const jobId = await createJobSheet(jobSheetData);
            console.log(`Created job sheet ${jobId} from conversation ${conversationDoc.id}`);
            processedCount.created++;
          } catch (jobError) {
            console.error('Failed to create job sheet:', jobError);
            processedCount.errors++;
          }
        }

        // Mark conversation as processed
        await updateDoc(doc(getConversationsCollection(), conversationDoc.id), {
          processed: true,
          processedAt: new Date().toISOString(),
          analysis: analysis
        });

      } catch (error) {
        console.error(`Error processing conversation ${conversationDoc.id}:`, error);
        processedCount.errors++;
      }
    }

    return NextResponse.json({
      success: true,
      processed: processedCount.total,
      jobsCreated: processedCount.created,
      errors: processedCount.errors
    });

  } catch (error) {
    console.error('Conversation analysis error:', error);
    return NextResponse.json(
      { error: 'Failed to analyze conversations' },
      { status: 500 }
    );
  }
}

// Convert analysis results to job sheet format
function createJobSheetFromAnalysis(analysis: any, conversationData: any) {
  const now = new Date().toISOString();

  return {
    status: 'new' as const,
    createdAt: now,
    reviewed: false,

    customer: {
      name: analysis.customerName || 'Unknown Customer',
      phone: analysis.phone || '',
      email: analysis.email || '',
      location: {
        suburb: analysis.suburb || 'Unknown',
        postcode: '',
        state: 'QLD',
      }
    },

    job: {
      title: analysis.jobDescription.substring(0, 100),
      description: analysis.jobDescription,
      category: analysis.jobCategory || 'general',
      urgency: analysis.urgencyLevel || 'unspecified',
      location: 'both' as const,

      materials: {
        surface: analysis.materials || '',
        condition: '',
        measurements: analysis.dimensions || '',
        access: 'ground_level' as const,
        customerSupplying: [],
        type: analysis.materials || ''
      },

      context: {
        historyNotes: analysis.missingInfo || '',
        accessNotes: '',
        equipmentNeeded: [],
        skillLevel: 'skilled_handyman' as const,
        problemHistory: ''
      }
    },

    estimate: {
      tier: 'skilled_handyman' as const,
      hourlyRate: 120,
      estimatedHours: { min: 2, max: 4 },
      estimatedCost: { min: 240, max: 480 },
      materialsEstimate: 100,
      totalEstimate: { min: 340, max: 580 },
      confidence: 'low' as const,
      notes: 'Estimated from incomplete conversation - needs follow-up',
      needsInspection: true
    },

    photos: [],

    aiAnalysis: {
      extractionConfidence: analysis.conversationQuality === 'complete' ? 0.8 :
                           analysis.conversationQuality === 'partial' ? 0.5 : 0.3,
      locationConfidence: analysis.suburb ? 0.7 : 0.3,
      flaggedForReview: `Extracted from incomplete conversation - ${analysis.missingInfo}`,
      suggestedActions: [
        'Contact customer for missing details',
        analysis.customerName ? '' : 'Get customer name',
        analysis.phone || analysis.email ? '' : 'Get contact information'
      ].filter(Boolean)
    },

    conversationData: {
      summary: `Auto-extracted: ${analysis.jobDescription.substring(0, 150)}...`
    },
    conversationText: conversationData.conversationText || ''
  };
}