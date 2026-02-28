import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';

const NOVA_CANVAS_MODEL_ID = process.env.NOVA_CANVAS_MODEL_ID || 'amazon.nova-canvas-v1:0';

let client: BedrockRuntimeClient | null = null;

function getClient(): BedrockRuntimeClient {
  if (!client) {
    client = new BedrockRuntimeClient({
      region: process.env.AWS_REGION || 'us-east-1',
    });
  }
  return client;
}

function parseResponse(body: Uint8Array): { images: string[]; error?: string } {
  const text = new TextDecoder().decode(body);
  return JSON.parse(text);
}

export async function removeBackground(imageBase64: string): Promise<string | null> {
  const clean = imageBase64.replace(/^data:image\/\w+;base64,/, '');
  try {
    const result = await getClient().send(
      new InvokeModelCommand({
        modelId: NOVA_CANVAS_MODEL_ID,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          taskType: 'BACKGROUND_REMOVAL',
          backgroundRemovalParams: {
            image: { format: 'png', source: { bytes: clean } },
          },
        }),
      })
    );
    const response = parseResponse(result.body!);
    if (response.error) {
      console.error('Nova Canvas background removal error:', response.error);
      return null;
    }
    return response.images?.[0] || null;
  } catch (error) {
    console.error('Nova Canvas background removal failed:', error);
    return null;
  }
}

export async function generateImageVariation(
  imageBase64: string,
  prompt: string,
  options: { similarityStrength?: number; width?: number; height?: number } = {}
): Promise<string | null> {
  const clean = imageBase64.replace(/^data:image\/\w+;base64,/, '');
  try {
    const result = await getClient().send(
      new InvokeModelCommand({
        modelId: NOVA_CANVAS_MODEL_ID,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          taskType: 'IMAGE_VARIATION',
          imageVariationParams: {
            text: prompt,
            images: [clean],
            similarityStrength: options.similarityStrength ?? 0.7,
          },
          imageGenerationConfig: {
            numberOfImages: 1,
            quality: 'premium',
            ...(options.width ? { width: options.width } : {}),
            ...(options.height ? { height: options.height } : {}),
          },
        }),
      })
    );
    const response = parseResponse(result.body!);
    if (response.error) {
      console.error('Nova Canvas image variation error:', response.error);
      return null;
    }
    return response.images?.[0] || null;
  } catch (error) {
    console.error('Nova Canvas image variation failed:', error);
    return null;
  }
}

export async function inpaintImage(
  imageBase64: string,
  maskPrompt: string,
  fillPrompt: string
): Promise<string | null> {
  const clean = imageBase64.replace(/^data:image\/\w+;base64,/, '');
  try {
    const result = await getClient().send(
      new InvokeModelCommand({
        modelId: NOVA_CANVAS_MODEL_ID,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          taskType: 'INPAINTING',
          inPaintingParams: {
            text: fillPrompt,
            negativeText: 'hands, fingers, thumbs, frame, border, glare',
            image: { format: 'png', source: { bytes: clean } },
            maskPrompt,
          },
          imageGenerationConfig: {
            numberOfImages: 1,
            quality: 'premium',
          },
        }),
      })
    );
    const response = parseResponse(result.body!);
    if (response.error) {
      console.error('Nova Canvas inpainting error:', response.error);
      return null;
    }
    return response.images?.[0] || null;
  } catch (error) {
    console.error('Nova Canvas inpainting failed:', error);
    return null;
  }
}

export async function textToImage(
  prompt: string,
  options: { width?: number; height?: number; negativePrompt?: string } = {}
): Promise<string | null> {
  try {
    const result = await getClient().send(
      new InvokeModelCommand({
        modelId: NOVA_CANVAS_MODEL_ID,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          taskType: 'TEXT_IMAGE',
          textToImageParams: {
            text: prompt,
            ...(options.negativePrompt ? { negativeText: options.negativePrompt } : {}),
          },
          imageGenerationConfig: {
            numberOfImages: 1,
            quality: 'premium',
            width: options.width ?? 1024,
            height: options.height ?? 1024,
          },
        }),
      })
    );
    const response = parseResponse(result.body!);
    if (response.error) {
      console.error('Nova Canvas text-to-image error:', response.error);
      return null;
    }
    return response.images?.[0] || null;
  } catch (error) {
    console.error('Nova Canvas text-to-image failed:', error);
    return null;
  }
}
