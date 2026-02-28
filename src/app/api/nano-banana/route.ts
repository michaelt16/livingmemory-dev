import { NextRequest, NextResponse } from 'next/server';
import { removeBackground, inpaintImage } from '@/lib/nova-canvas';
import { analyzeImage } from '@/lib/nova';

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  
  try {
    const body = await request.json();
    const { imageBase64 } = body;

    if (!imageBase64) {
      console.log('[nano-banana] No image provided in request');
      return NextResponse.json({ error: 'No image provided' }, { status: 400 });
    }

    console.log('');
    console.log('[nano-banana] API CALLED - Full Extraction');
    console.log('[nano-banana] Input size:', Math.round(imageBase64.length / 1024), 'KB');
    
    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');

    // Strategy 1: Try inpainting to remove hands/fingers and keep the photo
    console.log('[nano-banana] Trying Nova Canvas inpainting...');
    const inpaintResult = await inpaintImage(
      cleanBase64,
      'hands, fingers, thumbs, photo frame border, background surface',
      'Clean photograph content, professional digital scan of the photo'
    );

    if (inpaintResult) {
      const elapsed = Date.now() - startTime;
      console.log(`[nano-banana] SUCCESS via inpainting in ${elapsed}ms`);
      return NextResponse.json({
        success: true,
        imageBase64: inpaintResult,
        mimeType: 'image/png',
        description: 'Photo extracted with Nova Canvas inpainting',
        processingTimeMs: elapsed,
        model: 'nova-canvas-inpainting',
      });
    }

    // Strategy 2: Background removal to isolate the photo
    console.log('[nano-banana] Inpainting failed, trying background removal...');
    const bgRemoved = await removeBackground(cleanBase64);

    if (bgRemoved) {
      const elapsed = Date.now() - startTime;
      console.log(`[nano-banana] SUCCESS via background removal in ${elapsed}ms`);
      return NextResponse.json({
        success: true,
        imageBase64: bgRemoved,
        mimeType: 'image/png',
        description: 'Photo extracted with Nova Canvas background removal',
        processingTimeMs: elapsed,
        model: 'nova-canvas-bg-removal',
      });
    }

    // Strategy 3: Use Nova 2 Lite vision for bounding box, then crop server-side
    console.log('[nano-banana] Canvas methods failed, falling back to vision + crop...');
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

          const elapsed = Date.now() - startTime;
          console.log(`[nano-banana] SUCCESS via vision+crop in ${elapsed}ms`);
          return NextResponse.json({
            success: true,
            imageBase64: cropped.toString('base64'),
            mimeType: 'image/jpeg',
            description: 'Photo extracted with Nova vision + crop',
            processingTimeMs: elapsed,
            model: 'nova-2-lite-crop',
          });
        }
      }
    }

    console.log('[nano-banana] All extraction methods failed');
    return NextResponse.json({ 
      success: false, 
      error: 'All extraction methods failed. Try again.',
    }, { status: 500 });

  } catch (error: unknown) {
    const elapsed = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[nano-banana] FAILED after ${elapsed}ms:`, message);
    return NextResponse.json({ 
      success: false, 
      error: message || 'Nano Banana extraction failed' 
    }, { status: 500 });
  }
}
