import { NextRequest, NextResponse } from 'next/server';
import { analyzePhoto, askAboutImage } from '@/lib/nova';
import { PhotoAnalysis } from '@/lib/types';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { imageBase64, image, mimeType, prompt } = body;

    const imageData = imageBase64 || image;

    if (!imageData) {
      return NextResponse.json(
        { error: 'Image data is required' },
        { status: 400 }
      );
    }

    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');

    console.log(`[analyze-photo] Received image: ${base64Data.length} chars base64, prompt: ${prompt ? prompt.substring(0, 60) + '...' : 'none (full analysis)'}`);

    if (prompt) {
      const response = await askAboutImage(base64Data, prompt, mimeType || 'image/jpeg');
      console.log(`[analyze-photo] Response (prompt mode): ${(response || '').substring(0, 200)}`);
      return NextResponse.json({ response });
    }

    const analysis: PhotoAnalysis = await analyzePhoto(
      base64Data,
      mimeType || 'image/jpeg'
    );

    console.log(`[analyze-photo] Analysis result:`, JSON.stringify(analysis).substring(0, 300));
    return NextResponse.json({ analysis });
  } catch (error) {
    console.error('[analyze-photo] Error:', error);
    return NextResponse.json(
      { error: 'Failed to analyze photo' },
      { status: 500 }
    );
  }
}
