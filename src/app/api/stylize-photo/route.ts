/**
 * Style-transfer API for Disney, Ghibli, Anime, LEGO.
 * Uses Gemini image generation (same as nano-banana art pipeline) when
 * GEMINI_API_KEY is set for higher quality; falls back to Nova Canvas otherwise.
 *
 * Saves previews to Supabase inline (instead of calling /api/photos/.../style-previews via HTTP)
 * to avoid serverless self-referencing deadlocks on hosted platforms.
 */

import { NextRequest, NextResponse } from 'next/server';
import { generateImageVariation } from '@/lib/nova-canvas';
import { getAnimationStyle } from '@/lib/animation-styles';
import { createClient } from '@supabase/supabase-js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/** Generate stylized image via Gemini (same pipeline as nano-banana art). */
async function generateStylizedWithGemini(
  cleanBase64: string,
  prompt: string,
  modelName: string
): Promise<{ imageBase64: string; mimeType: string } | null> {
  if (!GEMINI_API_KEY) return null;
  try {
    const { GoogleGenAI } = await import('@google/genai').catch(() => ({ GoogleGenAI: null }));
    if (!GoogleGenAI) return null;
    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model: modelName,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: cleanBase64 } },
            { text: prompt },
          ],
        },
      ],
      config: {
        responseModalities: ['IMAGE', 'TEXT'],
      },
    });

    const candidates = response.candidates || [];
    if (candidates.length === 0) return null;
    const parts = candidates[0]?.content?.parts || [];
    for (const part of parts) {
      const partObj = part as { inlineData?: { mimeType?: string; data?: string } };
      if (partObj.inlineData?.mimeType?.startsWith('image/')) {
        return {
          imageBase64: partObj.inlineData.data || '',
          mimeType: partObj.inlineData.mimeType || 'image/png',
        };
      }
    }
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[stylize] Gemini ${modelName} failed:`, msg);
    return null;
  }
}

const GEMINI_IMAGE_MODELS = [
  'gemini-2.0-flash-preview-image-generation',
  'gemini-2.0-flash-exp',
  'gemini-2.0-flash',
  'gemini-3-pro-image-preview',
];

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

    const useGemini = !!GEMINI_API_KEY;
    console.log('');
    console.log(`[stylize] Style: ${style.label} (${style.id}) — engine: ${useGemini ? 'Gemini (nano-banana art)' : 'Nova Canvas'}`);
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
      let result: { imageBase64: string; mimeType: string } | null = null;
      let model = 'nova-canvas';

      if (useGemini) {
        for (const modelName of GEMINI_IMAGE_MODELS) {
          console.log(`[stylize] Preview ${i + 1} — trying ${modelName}...`);
          result = await generateStylizedWithGemini(cleanBase64, prompt, modelName);
          if (result) {
            model = modelName;
            console.log(`[stylize] Preview ${i + 1} — success (Gemini)`);
            break;
          }
        }
      }

      if (!result) {
        console.log(`[stylize] Preview ${i + 1} — ${useGemini ? 'Gemini failed, trying Nova Canvas...' : 'generating...'}`);
        const novaResult = await generateImageVariation(cleanBase64, prompt, {
          similarityStrength: 0.6,
        });
        if (novaResult) {
          result = { imageBase64: novaResult, mimeType: 'image/png' };
          model = 'nova-canvas';
          console.log(`[stylize] Preview ${i + 1} — success (Nova Canvas)`);
        }
      }

      if (result) {
        previews.push({ ...result, model });
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
      // Get the photo's event_id for storage path
      const { data: photo } = await supabase
        .from('photos')
        .select('id, event_id')
        .eq('id', photoId)
        .single();

      for (let i = 0; i < previews.length; i++) {
        const p = previews[i];
        if (!photo) {
          savedPreviews.push({ imageBase64: p.imageBase64, mimeType: p.mimeType, model: p.model });
          continue;
        }
        try {
          const shouldSelect = i === 0 && count <= 2;

          // Upload image to Supabase storage
          const buffer = Buffer.from(p.imageBase64, 'base64');
          const ext = p.mimeType.includes('png') ? 'png' : 'jpg';
          const fileName = `${photo.event_id}/style-previews/${photoId}_${style.id}_${Date.now()}_${i}.${ext}`;

          const { error: uploadError } = await supabase.storage
            .from('event-photos')
            .upload(fileName, buffer, { contentType: p.mimeType, upsert: false });

          if (uploadError) {
            console.error(`[stylize] Upload error for preview ${i + 1}:`, uploadError);
            savedPreviews.push({ imageBase64: p.imageBase64, mimeType: p.mimeType, model: p.model });
            continue;
          }

          const { data: urlData } = supabase.storage.from('event-photos').getPublicUrl(fileName);
          const imageUrl = urlData.publicUrl;

          // Deselect existing previews if this one should be selected
          if (shouldSelect) {
            await supabase
              .from('style_previews')
              .update({ is_selected: false })
              .eq('photo_id', photoId)
              .eq('style_id', style.id);
          }

          // Insert DB record
          const { data: preview, error: insertError } = await supabase
            .from('style_previews')
            .insert({
              photo_id: photoId,
              style_id: style.id,
              image_url: imageUrl,
              is_selected: shouldSelect,
              model: p.model || null,
            })
            .select()
            .single();

          if (insertError) {
            console.error(`[stylize] DB insert error for preview ${i + 1}:`, insertError);
            savedPreviews.push({ imageUrl, imageBase64: p.imageBase64, mimeType: p.mimeType, model: p.model });
          } else {
            savedPreviews.push({
              id: preview.id,
              imageUrl: preview.image_url,
              imageBase64: p.imageBase64,
              mimeType: p.mimeType,
              model: p.model,
            });
          }
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
