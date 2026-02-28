import { analyzeImage, generateText } from '@/lib/nova';

// This API route handles live multimodal conversations with Nova
// It accepts video frames and text, and streams back responses (non-streaming model, simulated SSE)

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { imageBase64, message, conversationHistory = [] } = body;

    // System context for live conversation
    const systemContext = `You are a friendly, warm AI assistant helping someone explore and share memories through their photos. 
You can see what they're showing you through their camera.

Your personality:
- Warm, encouraging, and genuinely curious about their stories
- Ask thoughtful follow-up questions that dig deeper into emotions and relationships
- Notice small details in the photos and ask about them
- Help them articulate memories they might not have words for yet

Guidelines:
- Keep responses conversational and brief (2-3 sentences max)
- If you can see a photo/image, describe what you notice and ask about it
- If they're showing you something new, acknowledge the change
- Remember context from the conversation

Current conversation context:
${conversationHistory.map((msg: { role: string; content: string }) => `${msg.role}: ${msg.content}`).join('\n')}
`;

    const userPrompt = message
      ? `User says: ${message}`
      : imageBase64
        ? 'User is showing you something through their camera. What do you see? Ask them about it.'
        : '';

    let text: string;
    if (imageBase64 && userPrompt) {
      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
      text = await analyzeImage(base64Data, userPrompt, 'image/jpeg', {
        systemPrompt: systemContext,
        maxTokens: 1024,
      });
    } else if (userPrompt) {
      text = await generateText(userPrompt, {
        systemPrompt: systemContext,
        maxTokens: 1024,
        temperature: 0.7,
      });
    } else {
      text = '';
    }

    // Simulate streaming response (Nova doesn't stream, send full text as single chunk)
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        if (text) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    console.error('Live API error:', error);
    return Response.json(
      { error: 'Failed to process request' },
      { status: 500 }
    );
  }
}
