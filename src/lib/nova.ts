import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
  type ImageFormat,
} from '@aws-sdk/client-bedrock-runtime';

const NOVA_LITE_MODEL_ID = process.env.NOVA_MODEL_ID || 'us.amazon.nova-2-lite-v1:0';

let client: BedrockRuntimeClient | null = null;

function getClient(): BedrockRuntimeClient {
  if (!client) {
    client = new BedrockRuntimeClient({
      region: process.env.AWS_REGION || 'us-east-1',
    });
  }
  return client;
}

function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

function extractFormat(mimeType: string): ImageFormat {
  const sub = mimeType.split('/')[1]?.toLowerCase();
  if (sub === 'png') return 'png';
  if (sub === 'gif') return 'gif';
  if (sub === 'webp') return 'webp';
  return 'jpeg';
}

function getResponseText(result: { output?: { message?: { content?: ContentBlock[] } } }): string {
  const content = result.output?.message?.content;
  if (!content) return '';
  for (const block of content) {
    if ('text' in block && block.text) return block.text;
  }
  return '';
}

export async function generateText(
  prompt: string,
  options: { systemPrompt?: string; maxTokens?: number; temperature?: number } = {}
): Promise<string> {
  const result = await getClient().send(
    new ConverseCommand({
      modelId: NOVA_LITE_MODEL_ID,
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      ...(options.systemPrompt ? { system: [{ text: options.systemPrompt }] } : {}),
      inferenceConfig: {
        maxTokens: options.maxTokens ?? 4096,
        temperature: options.temperature ?? 0.7,
      },
    })
  );
  return getResponseText(result);
}

export async function analyzeImage(
  imageBase64: string,
  prompt: string,
  mimeType: string = 'image/jpeg',
  options: { systemPrompt?: string; maxTokens?: number } = {}
): Promise<string> {
  const clean = imageBase64.replace(/^data:image\/\w+;base64,/, '');
  const result = await getClient().send(
    new ConverseCommand({
      modelId: NOVA_LITE_MODEL_ID,
      messages: [
        {
          role: 'user',
          content: [
            { image: { format: extractFormat(mimeType), source: { bytes: base64ToBytes(clean) } } },
            { text: prompt },
          ],
        },
      ],
      ...(options.systemPrompt ? { system: [{ text: options.systemPrompt }] } : {}),
      inferenceConfig: { maxTokens: options.maxTokens ?? 4096 },
    })
  );
  return getResponseText(result);
}

export async function chat(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  options: { systemPrompt?: string; maxTokens?: number } = {}
): Promise<string> {
  const novaMessages: Message[] = messages.map((m) => ({
    role: m.role,
    content: [{ text: m.content }],
  }));
  const result = await getClient().send(
    new ConverseCommand({
      modelId: NOVA_LITE_MODEL_ID,
      messages: novaMessages,
      ...(options.systemPrompt ? { system: [{ text: options.systemPrompt }] } : {}),
      inferenceConfig: { maxTokens: options.maxTokens ?? 4096 },
    })
  );
  return getResponseText(result);
}

export interface ImagePart {
  base64: string;
  mimeType: string;
  label?: string;
}

export async function generateWithImages(
  prompt: string,
  images: ImagePart[],
  options: { systemPrompt?: string; maxTokens?: number } = {}
): Promise<string> {
  const content: ContentBlock[] = [];
  for (const img of images) {
    const clean = img.base64.replace(/^data:image\/\w+;base64,/, '');
    if (img.label) content.push({ text: img.label });
    content.push({
      image: {
        format: extractFormat(img.mimeType),
        source: { bytes: base64ToBytes(clean) },
      },
    });
  }
  content.push({ text: prompt });

  const result = await getClient().send(
    new ConverseCommand({
      modelId: NOVA_LITE_MODEL_ID,
      messages: [{ role: 'user', content }],
      ...(options.systemPrompt ? { system: [{ text: options.systemPrompt }] } : {}),
      inferenceConfig: { maxTokens: options.maxTokens ?? 4096 },
    })
  );
  return getResponseText(result);
}

export async function analyzePhoto(imageBase64: string, mimeType: string = 'image/jpeg') {
  const { PHOTO_ANALYSIS_PROMPT } = await import('./prompts');
  const text = await analyzeImage(imageBase64, PHOTO_ANALYSIS_PROMPT, mimeType);
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Failed to parse photo analysis response');
  return JSON.parse(jsonMatch[0]);
}

export async function askAboutImage(
  imageBase64: string,
  prompt: string,
  mimeType: string = 'image/jpeg'
): Promise<string> {
  return analyzeImage(imageBase64, prompt, mimeType);
}

export async function startConversation(photoAnalysis: string): Promise<string> {
  const { buildConversationPrompt } = await import('./prompts');
  const prompt = buildConversationPrompt(photoAnalysis, [], { names: [], places: [], dates: [] });
  return generateText(prompt);
}

export async function fetchImageAsNovaInput(url: string): Promise<ImagePart | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    const mimeType = contentType.split(';')[0].trim();
    return { base64, mimeType };
  } catch {
    return null;
  }
}
