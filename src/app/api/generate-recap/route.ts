import { NextResponse } from 'next/server';
import { generateText } from '@/lib/nova';

export async function POST(request: Request) {
  try {
    const { conversation } = await request.json();
    
    if (!conversation || typeof conversation !== 'string') {
      return NextResponse.json({ error: 'Conversation text required' }, { status: 400 });
    }
    
    const prompt = `You are summarizing a conversation about a family photo/memory. Create a brief, warm recap (2-3 sentences max) that captures the key details shared.

Focus on:
- Who is in the photo
- When/where it was taken (if mentioned)
- The story or significance behind it
- Any emotions or special moments mentioned

Keep it conversational and heartfelt, like a caption for the memory.

CONVERSATION:
${conversation}

RECAP:`;

    const recap = await generateText(prompt);
    
    return NextResponse.json({ recap: recap.trim() });
  } catch (error) {
    console.error('Generate recap error:', error);
    return NextResponse.json(
      { error: 'Failed to generate recap' },
      { status: 500 }
    );
  }
}
