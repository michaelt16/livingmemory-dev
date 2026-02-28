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

    if (prompt) {
      const response = await askAboutImage(base64Data, prompt, mimeType || 'image/jpeg');
      return NextResponse.json({ response });
    }

    const analysis: PhotoAnalysis = await analyzePhoto(
      base64Data,
      mimeType || 'image/jpeg'
    );

    return NextResponse.json({ analysis });
  } catch (error) {
    console.error('Photo analysis error:', error);
    return NextResponse.json(
      { error: 'Failed to analyze photo' },
      { status: 500 }
    );
  }
}
