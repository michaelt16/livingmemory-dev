import { NextRequest, NextResponse } from 'next/server';
import { analyzeImage } from '@/lib/nova';

function safeResponse(
  detected: boolean,
  allCornersVisible: boolean,
  issues: string[] = []
) {
  return NextResponse.json({
    detected,
    confidence: detected ? (allCornersVisible ? 0.9 : 0.6) : 0,
    allCornersVisible,
    quality: allCornersVisible ? 'good' : (detected ? 'partial' : 'poor'),
    issues: allCornersVisible ? [] : (detected ? ['Some corners not visible'] : issues.length ? issues : ['No photo detected']),
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { imageBase64 } = body;

    if (!imageBase64) {
      return NextResponse.json({ error: 'No image provided' }, { status: 400 });
    }

    const prompt = `You are looking at a camera image. 

1. Is there a physical photograph, printed picture, or paper document visible in the image? (Answer PHOTO:YES or PHOTO:NO)
2. If yes, are most or all of its four corners visible (not cut off by the edges)? (Answer CORNERS:YES or CORNERS:NO)

Reply with exactly two words in this format: PHOTO:YES CORNERS:YES or PHOTO:YES CORNERS:NO or PHOTO:NO CORNERS:NO. Nothing else.`;

    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    if (!cleanBase64 || cleanBase64.length < 100) {
      return safeResponse(false, false, ['Invalid image data']);
    }

    let text: string;
    try {
      text = await analyzeImage(cleanBase64, prompt, 'image/jpeg');
    } catch {
      return safeResponse(false, false, ['Could not read model response']);
    }

    if (!text) {
      return safeResponse(false, false, ['Empty model response']);
    }

    const upper = text.toUpperCase();
    const hasPhoto = /PHOTO\s*:\s*YES|PHOTO\s+YES/i.test(upper);
    const allCornersVisible = /CORNERS\s*:\s*YES|CORNERS\s+YES/i.test(upper);

    return safeResponse(hasPhoto, allCornersVisible);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Photo check error:', message);
    return safeResponse(false, false, [`Analysis failed: ${message}`]);
  }
}
