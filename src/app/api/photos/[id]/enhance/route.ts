/**
 * POST /api/photos/[id]/enhance
 * Run Nano Banana crop on a photo and replace original/thumbnail with the enhanced version.
 * Use when the photo wasn't cropped during capture (e.g. user talked to AI before cropping).
 *
 * Runs extraction logic inline (instead of calling /api/nano-banana via HTTP)
 * to avoid serverless self-referencing deadlocks on hosted platforms.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { removeBackground, inpaintImage } from '@/lib/nova-canvas';
import { analyzeImage } from '@/lib/nova';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const BUCKET = 'event-photos';

async function runNanoBanana(cleanBase64: string): Promise<{ success: boolean; imageBase64?: string; mimeType?: string; error?: string }> {
  // Strategy 1: Try inpainting to remove hands/fingers and keep the photo
  console.log('[nano-banana/enhance] Trying Nova Canvas inpainting...');
  const inpaintResult = await inpaintImage(
    cleanBase64,
    'hands, fingers, thumbs, photo frame border, background surface',
    'Clean photograph content, professional digital scan of the photo'
  );

  if (inpaintResult) {
    console.log('[nano-banana/enhance] SUCCESS via inpainting');
    return { success: true, imageBase64: inpaintResult, mimeType: 'image/png' };
  }

  // Strategy 2: Background removal to isolate the photo
  console.log('[nano-banana/enhance] Inpainting failed, trying background removal...');
  const bgRemoved = await removeBackground(cleanBase64);

  if (bgRemoved) {
    console.log('[nano-banana/enhance] SUCCESS via background removal');
    return { success: true, imageBase64: bgRemoved, mimeType: 'image/png' };
  }

  // Strategy 3: Use Nova 2 Lite vision for bounding box, then crop server-side
  console.log('[nano-banana/enhance] Canvas methods failed, falling back to vision + crop...');
  const bboxPrompt = `You are looking at someone holding a physical photograph. 
Return ONLY a JSON object with the bounding box of the photograph content (NOT including hands, fingers, frame, or background).
Use coordinates on a 0-1000 scale: {"x": <left>, "y": <top>, "width": <width>, "height": <height>}
If no photograph is visible: {"error": "no photo detected"}`;

  const bboxText = await analyzeImage(cleanBase64, bboxPrompt, 'image/jpeg');
  const bboxMatch = bboxText.match(/\{[^}]+\}/);

  if (bboxMatch) {
    const bbox = JSON.parse(bboxMatch[0]);
    if (bbox.x !== undefined && bbox.width > 0) {
      const sharp = (await import('sharp')).default;
      const imageBuffer = Buffer.from(cleanBase64, 'base64');
      const metadata = await sharp(imageBuffer).metadata();
      const imgW = metadata.width || 1000;
      const imgH = metadata.height || 1000;

      let x = Math.round((bbox.x / 1000) * imgW);
      let y = Math.round((bbox.y / 1000) * imgH);
      let w = Math.round((bbox.width / 1000) * imgW);
      let h = Math.round((bbox.height / 1000) * imgH);

      const padX = Math.round(w * 0.03);
      const padY = Math.round(h * 0.03);
      x = Math.max(0, x + padX);
      y = Math.max(0, y + padY);
      w = Math.min(w - padX * 2, imgW - x);
      h = Math.min(h - padY * 2, imgH - y);

      if (w > 50 && h > 50) {
        const cropped = await sharp(imageBuffer)
          .extract({ left: x, top: y, width: w, height: h })
          .jpeg({ quality: 92 })
          .toBuffer();

        console.log('[nano-banana/enhance] SUCCESS via vision+crop');
        return { success: true, imageBase64: cropped.toString('base64'), mimeType: 'image/jpeg' };
      }
    }
  }

  return { success: false, error: 'All extraction methods failed. Try again.' };
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: photoId } = await params;

  try {
    const { data: photo, error: photoError } = await supabase
      .from('photos')
      .select('id, event_id, original_url, thumbnail_url')
      .eq('id', photoId)
      .single();

    if (photoError || !photo) {
      return NextResponse.json({ error: 'Photo not found' }, { status: 404 });
    }

    const imageUrl = photo.original_url || photo.thumbnail_url;
    if (!imageUrl) {
      return NextResponse.json({ error: 'Photo has no image URL' }, { status: 400 });
    }

    // Fetch the image
    const imageRes = await fetch(imageUrl);
    if (!imageRes.ok) {
      return NextResponse.json({ error: 'Failed to fetch photo image' }, { status: 502 });
    }

    const arrayBuffer = await imageRes.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');

    // Run Nano Banana extraction inline (no internal HTTP call)
    const nanoData = await runNanoBanana(base64);

    if (!nanoData.success || !nanoData.imageBase64) {
      return NextResponse.json(
        { error: nanoData.error || 'No enhanced image returned' },
        { status: 500 }
      );
    }

    // Upload to storage
    const buffer = Buffer.from(nanoData.imageBase64, 'base64');
    const ext = nanoData.mimeType?.includes('png') ? 'png' : 'jpg';
    const fileName = `${photo.event_id}/enhanced/${photoId}_${Date.now()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(fileName, buffer, {
        contentType: nanoData.mimeType || 'image/jpeg',
        upsert: true,
      });

    if (uploadError) {
      console.error('Enhance upload error:', uploadError);
      return NextResponse.json({ error: 'Failed to upload enhanced photo' }, { status: 500 });
    }

    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(fileName);
    const newUrl = urlData.publicUrl;

    // Update photo with new URLs
    const { data: updated, error: updateError } = await supabase
      .from('photos')
      .update({
        original_url: newUrl,
        thumbnail_url: newUrl,
      })
      .eq('id', photoId)
      .select()
      .single();

    if (updateError) {
      console.error('Enhance update error:', updateError);
      return NextResponse.json({ error: 'Failed to update photo' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      original_url: newUrl,
      thumbnail_url: newUrl,
      photo: updated,
    });
  } catch (error) {
    console.error('Enhance photo error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Enhance failed' },
      { status: 500 }
    );
  }
}
