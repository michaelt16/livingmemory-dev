import { NextRequest, NextResponse } from 'next/server';
import { generateText } from '@/lib/nova';
import { buildConversationPrompt } from '@/lib/prompts';
import { ConversationMessage, ChatResponse } from '@/lib/types';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { 
      photoAnalysis, 
      messages, 
      userMessage,
      dossier = { names: [], places: [], dates: [] }
    } = body;

    if (!photoAnalysis) {
      return NextResponse.json(
        { error: 'Photo analysis is required' },
        { status: 400 }
      );
    }

    const conversationHistory = messages.map((m: ConversationMessage) => ({
      role: m.role,
      content: m.content,
    }));

    if (userMessage) {
      conversationHistory.push({
        role: 'user',
        content: userMessage,
      });
    }

    const turnCount = conversationHistory.filter((m: { role: string }) => m.role === 'user').length;

    const prompt = buildConversationPrompt(
      JSON.stringify(photoAnalysis, null, 2),
      conversationHistory,
      dossier,
      turnCount
    );

    const fullPrompt = `${prompt}\n\nElderly Person: ${userMessage || 'Please start the conversation.'}`;
    const responseText = await generateText(fullPrompt);

    // Parse the response to extract the JSON metadata
    const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/);
    let extractedInfo = { names: [], places: [], dates: [] };
    let suggestComplete = false;
    let cleanMessage = responseText;

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        extractedInfo = {
          names: parsed.names || [],
          places: parsed.places || [],
          dates: parsed.dates || [],
        };
        suggestComplete = parsed.suggestComplete || false;
        // Remove the JSON block from the message
        cleanMessage = responseText.replace(/```json[\s\S]*?```/, '').trim();
      } catch {
        // JSON parsing failed, use defaults
      }
    }

    const response: ChatResponse = {
      message: cleanMessage,
      extractedInfo,
      suggestComplete,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Chat error:', error);
    return NextResponse.json(
      { error: 'Failed to generate response' },
      { status: 500 }
    );
  }
}
