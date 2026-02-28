import { NextRequest, NextResponse } from 'next/server';
import { generateImageVariation } from '@/lib/nova-canvas';
import { getAnimationStyle } from '@/lib/animation-styles';

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    const body = await request.json();
    const { imageBase64: rawBase64, photoUrl, photoId, styleId, count = 2 } = body;

    let imageBase64 = rawBase64 || '';
    if (!imageBase64 && photoUrl) {
      if (photoUrl.startsWith('http://') || photoUrl.startsWith('https://')) {
        try {
          const imgRes = await fetch(photoUrl);
          if (imgRes.ok) {
            const buf = await imgRes.arrayBuffer();
            const b64 = Buffer.from(buf).toString('base64');
            const ct = imgRes.headers.get('content-type') || 'image/jpeg';
            imageBase64 = `data:${ct};base64,${b64}`;
          }
        } catch (fetchErr) {
          console.error('[stylize] Error fetching image URL:', fetchErr);
        }
      } else {
        imageBase64 = photoUrl;
      }
    }

    if (!imageBase64) {
      return NextResponse.json({ error: 'No image provided' }, { status: 400 });
    }

    const style = getAnimationStyle(styleId);
    if (!style.needsStyleTransfer || !style.styleTransferPrompt) {
      return NextResponse.json(
        { error: 'This style does not require style transfer' },
        { status: 400 },
      );
    }

    console.log('');
    console.log(`[stylize] Style: ${style.label} (${style.id})`);
    console.log(`[stylize] Generating ${count} preview(s)...`);

    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const numPreviews = Math.min(Math.max(count, 1), 4);
    const previews: { imageBase64: string; mimeType: string; model: string }[] = [];

    const promptVariants = [
      style.styleTransferPrompt,
      style.styleTransferPrompt + ' Use slightly different color grading and lighting.',
    ];

    for (let i = 0; i < numPreviews; i++) {
      const prompt = promptVariants[i % promptVariants.length];
      console.log(`[stylize] Preview ${i + 1} — generating...`);

      const result = await generateImageVariation(cleanBase64, prompt, {
        similarityStrength: 0.6,
      });

      if (result) {
        previews.push({ imageBase64: result, mimeType: 'image/png', model: 'nova-canvas' });
        console.log(`[stylize] Preview ${i + 1} — success`);
      } else {
        console.log(`[stylize] Preview ${i + 1} — failed`);
      }
    }

    if (previews.length === 0) {
      console.log('[stylize] All previews failed');
      return NextResponse.json(
        { error: 'Failed to generate style previews. Try again.' },
        { status: 500 },
      );
    }

    const savedPreviews: { id?: string; imageUrl?: string; imageBase64: string; mimeType: string; model: string }[] = [];

    if (photoId) {
      const origin = request.nextUrl.origin;
      for (let i = 0; i < previews.length; i++) {
        const p = previews[i];
        try {
          const saveRes = await fetch(`${origin}/api/photos/${photoId}/style-previews`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              styleId: style.id,
              imageBase64: p.imageBase64,
              mimeType: p.mimeType,
              model: p.model,
              select: i === 0 && count <= 2,
            }),
          });
          const saveData = saveRes.ok ? await saveRes.json() : null;
          savedPreviews.push({
            id: saveData?.preview?.id,
            imageUrl: saveData?.preview?.image_url,
            imageBase64: p.imageBase64,
            mimeType: p.mimeType,
            model: p.model,
          });
        } catch (saveErr) {
          console.error(`[stylize] Failed to save preview ${i + 1}:`, saveErr);
          savedPreviews.push({ imageBase64: p.imageBase64, mimeType: p.mimeType, model: p.model });
        }
      }
    } else {
      for (const p of previews) {
        savedPreviews.push({ imageBase64: p.imageBase64, mimeType: p.mimeType, model: p.model });
      }
    }

    const elapsed = Date.now() - startTime;
    console.log(`[stylize] Generated ${previews.length} preview(s) in ${elapsed}ms`);

    return NextResponse.json({
      success: true,
      style: style.id,
      styleLabel: style.label,
      previews: savedPreviews,
      processingTimeMs: elapsed,
    });
  } catch (error: unknown) {
    const elapsed = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[stylize] FAILED after ${elapsed}ms:`, message);
    return NextResponse.json(
      { error: message || 'Style transfer failed' },
      { status: 500 },
    );
  }
}
