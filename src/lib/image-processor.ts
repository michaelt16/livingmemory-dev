import { analyzeImage } from '@/lib/nova';
import { removeBackground } from '@/lib/nova-canvas';

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProcessedImage {
  imageBase64: string;
  mimeType: string;
  description?: string;
  boundingBox?: BoundingBox;
}

async function getPhotoBoundingBox(imageBase64: string): Promise<BoundingBox | null> {
  const prompt = `You are a precise image cropping assistant. A person is holding up or showing a physical photograph to the camera.

TASK: Return the EXACT bounding box of ONLY the photograph itself - NOT including:
- Hands or fingers holding the photo
- The photo frame or border (if any)
- Any background behind the photo
- Table surface or any other objects

Focus on the IMAGE CONTENT inside the photograph only.

Return a JSON object with coordinates on a 0-1000 scale:
{"x": <left>, "y": <top>, "width": <width>, "height": <height>}

Where:
- x=0 is left edge of camera view, x=1000 is right edge
- y=0 is top edge, y=1000 is bottom edge
- The box should tightly wrap ONLY the photo content, excluding fingers/hands

If you see fingers covering corners, estimate where the photo edge would be behind the finger.

If no distinct photograph is visible, return: {"error": "no photo detected"}

ONLY return the JSON, nothing else.`;

  try {
    const text = await analyzeImage(imageBase64, prompt, 'image/jpeg');
    const jsonMatch = text.match(/\{[^}]+\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed.error) return null;

    if (
      typeof parsed.x === 'number' &&
      typeof parsed.y === 'number' &&
      typeof parsed.width === 'number' &&
      typeof parsed.height === 'number'
    ) {
      return parsed;
    }
    return null;
  } catch (error) {
    console.error('Error getting bounding box:', error);
    return null;
  }
}

async function cropImageWithBoundingBox(
  imageBase64: string,
  bbox: BoundingBox
): Promise<string> {
  try {
    const sharp = (await import('sharp')).default;
    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(cleanBase64, 'base64');
    const metadata = await sharp(imageBuffer).metadata();
    const imgWidth = metadata.width || 1000;
    const imgHeight = metadata.height || 1000;

    let x = Math.round((bbox.x / 1000) * imgWidth);
    let y = Math.round((bbox.y / 1000) * imgHeight);
    let width = Math.round((bbox.width / 1000) * imgWidth);
    let height = Math.round((bbox.height / 1000) * imgHeight);

    const padX = Math.round(width * 0.03);
    const padY = Math.round(height * 0.03);
    x += padX;
    y += padY;
    width -= padX * 2;
    height -= padY * 2;

    x = Math.max(0, x);
    y = Math.max(0, y);
    width = Math.min(width, imgWidth - x);
    height = Math.min(height, imgHeight - y);

    if (width < 50 || height < 50) {
      return imageBase64;
    }

    const croppedBuffer = await sharp(imageBuffer)
      .extract({ left: x, top: y, width, height })
      .jpeg({ quality: 90 })
      .toBuffer();

    return `data:image/jpeg;base64,${croppedBuffer.toString('base64')}`;
  } catch (error) {
    console.error('Sharp not available or crop failed:', error);
    return imageBase64;
  }
}

async function centerCropFallback(imageBase64: string): Promise<string | null> {
  try {
    const sharp = (await import('sharp')).default;
    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(cleanBase64, 'base64');
    const metadata = await sharp(imageBuffer).metadata();
    const imgWidth = metadata.width || 1000;
    const imgHeight = metadata.height || 1000;
    const width = Math.round(imgWidth * 0.7);
    const height = Math.round(imgHeight * 0.62);
    const x = Math.round((imgWidth - width) / 2);
    const y = Math.round((imgHeight - height) / 2);
    const croppedBuffer = await sharp(imageBuffer)
      .extract({ left: Math.max(0, x), top: Math.max(0, y), width: Math.min(width, imgWidth), height: Math.min(height, imgHeight) })
      .jpeg({ quality: 90 })
      .toBuffer();
    return `data:image/jpeg;base64,${croppedBuffer.toString('base64')}`;
  } catch (error) {
    console.error('Center crop fallback failed:', error);
    return null;
  }
}

async function extractWithNovaCanvas(imageBase64: string): Promise<string | null> {
  console.log('[Nova Canvas] Starting background removal extraction...');
  try {
    const clean = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const result = await removeBackground(clean);
    if (result) {
      console.log('[Nova Canvas] Background removal succeeded');
      return `data:image/png;base64,${result}`;
    }
    console.log('[Nova Canvas] Background removal returned no result');
    return null;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log('[Nova Canvas] Extraction failed:', msg);
    return null;
  }
}

export async function processDraftPhoto(
  imageBase64: string
): Promise<ProcessedImage> {
  console.log('DRAFT PHOTO PROCESSING (Quick Crop)');

  const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
  console.log('Input image size:', Math.round(cleanBase64.length / 1024), 'KB');

  const bbox = await getPhotoBoundingBox(imageBase64);
  
  if (bbox) {
    console.log('Photo detected, cropping...');
    const croppedImage = await cropImageWithBoundingBox(imageBase64, bbox);
    const croppedBase64 = croppedImage.replace(/^data:image\/\w+;base64,/, '');
    
    return {
      imageBase64: croppedBase64,
      mimeType: 'image/jpeg',
      description: 'Draft photo cropped',
      boundingBox: bbox,
    };
  }
  
  console.log('No bbox detected, using center crop fallback');
  const centerCropped = await centerCropFallback(imageBase64);
  if (centerCropped) {
    const croppedBase64 = centerCropped.replace(/^data:image\/\w+;base64,/, '');
    return {
      imageBase64: croppedBase64,
      mimeType: 'image/jpeg',
      description: 'Draft photo center-cropped',
    };
  }
  
  return {
    imageBase64: cleanBase64,
    mimeType: 'image/jpeg',
    description: 'Original (no crop possible)',
  };
}

export async function processWithNanoBanana(
  imageBase64: string
): Promise<ProcessedImage> {
  console.log('NOVA CANVAS EXTRACTION');

  const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
  console.log('Input image size:', Math.round(cleanBase64.length / 1024), 'KB');

  const novaResult = await extractWithNovaCanvas(imageBase64);
  
  if (novaResult) {
    console.log('SUCCESS: Photo extracted with Nova Canvas');
    const extractedBase64 = novaResult.replace(/^data:image\/\w+;base64,/, '');
    return {
      imageBase64: extractedBase64,
      mimeType: 'image/png',
      description: 'Full-frame photo extracted with Nova Canvas',
    };
  }
  
  console.log('Nova Canvas failed, falling back to vision+crop');
  return processDraftPhoto(imageBase64);
}

export async function processScannedPhoto(
  imageBase64: string
): Promise<ProcessedImage> {
  return processDraftPhoto(imageBase64);
}

export async function cropAndEnhancePhoto(
  imageBase64: string
): Promise<string> {
  try {
    const result = await processScannedPhoto(imageBase64);
    return `data:${result.mimeType};base64,${result.imageBase64}`;
  } catch (error) {
    console.error('Crop and enhance failed, using original:', error);
    if (imageBase64.startsWith('data:')) return imageBase64;
    return `data:image/jpeg;base64,${imageBase64}`;
  }
}
