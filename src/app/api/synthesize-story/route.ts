import { NextRequest, NextResponse } from 'next/server';
import { generateText } from '@/lib/nova';
import { buildSynthesisPrompt } from '@/lib/prompts';
import { ConversationMessage } from '@/lib/types';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { 
      photoAnalysis, 
      messages,
      dossier = { names: [], places: [], dates: [] }
    } = body;

    if (!photoAnalysis || !messages || messages.length === 0) {
      return NextResponse.json(
        { error: 'Photo analysis and conversation messages are required' },
        { status: 400 }
      );
    }

    // Build conversation history for synthesis
    const conversationHistory = messages.map((m: ConversationMessage) => ({
      role: m.role,
      content: m.content,
    }));

    // Build the synthesis prompt
    const prompt = buildSynthesisPrompt(
      JSON.stringify(photoAnalysis, null, 2),
      conversationHistory,
      dossier
    );

    // Get the synthesized narrative
    const narrative = (await generateText(prompt)).trim();

    // Estimate duration (roughly 2.5 words per second for natural speech)
    const wordCount = narrative.split(/\s+/).length;
    const estimatedDuration = Math.ceil(wordCount / 2.5);

    return NextResponse.json({ 
      narrative,
      wordCount,
      estimatedDuration, // in seconds
    });
  } catch (error) {
    console.error('Story synthesis error:', error);
    return NextResponse.json(
      { error: 'Failed to synthesize story' },
      { status: 500 }
    );
  }
}
