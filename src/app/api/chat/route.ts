import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt } from '@/lib/ai/prompts/systemPrompt';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

const SYSTEM_PROMPT = buildSystemPrompt();

export async function POST(request: NextRequest) {
  try {
    const { messages, photos } = await request.json();

    // Include photos in the context if provided
    let messageContent = messages[messages.length - 1].content;
    if (photos && photos.length > 0) {
      messageContent += `\n\n[User has uploaded ${photos.length} photo(s)]`;
    }

    const response = await anthropic.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [
        ...messages.slice(0, -1),
        {
          role: 'user',
          content: messageContent,
        }
      ],
    });

    const assistantMessage = response.content[0].type === 'text'
      ? response.content[0].text
      : '';

    return NextResponse.json({
      message: assistantMessage
    });
  } catch (error) {
    console.error('Chat API error:', error);
    return NextResponse.json(
      { error: 'Failed to process chat message' },
      { status: 500 }
    );
  }
}
