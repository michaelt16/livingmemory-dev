import { NextRequest, NextResponse } from 'next/server';
import { PollyClient, SynthesizeSpeechCommand, type VoiceId, type Engine } from '@aws-sdk/client-polly';
import { createServerClient } from '@/lib/supabase/server';

interface TTSRequest {
  text: string;
  voice?: {
    name?: string;
  };
  save_to_storage?: boolean;
  storage_path?: string;
}

const VOICE_MAP: Record<string, VoiceId> = {
  'Kore': 'Ruth',
  'Puck': 'Matthew',
  'Charon': 'Stephen',
  'Fenrir': 'Gregory',
  'Aoede': 'Danielle',
  'Ruth': 'Ruth',
  'Matthew': 'Matthew',
  'Joanna': 'Joanna',
  'Danielle': 'Danielle',
  'Stephen': 'Stephen',
  'Gregory': 'Gregory',
};

const DEFAULT_VOICE: VoiceId = 'Ruth';
const DEFAULT_ENGINE: Engine = 'generative';

const ttsCache = new Map<string, { audio_base64: string; mime_type: string; cached_at: number }>();
const CACHE_TTL = 60 * 60 * 1000;

function getCacheKey(text: string, voice: string): string {
  return `${voice}:${text.trim().toLowerCase()}`;
}

function cleanCache(): void {
  const now = Date.now();
  for (const [key, value] of ttsCache.entries()) {
    if (now - value.cached_at > CACHE_TTL) {
      ttsCache.delete(key);
    }
  }
}

let pollyClient: PollyClient | null = null;

function getPollyClient(): PollyClient {
  if (!pollyClient) {
    pollyClient = new PollyClient({
      region: process.env.AWS_REGION || 'us-east-1',
    });
  }
  return pollyClient;
}

export async function POST(request: NextRequest) {
  try {
    const body: TTSRequest = await request.json();
    const { text, voice = {}, save_to_storage = false, storage_path } = body;

    if (!text || typeof text !== 'string') {
      return NextResponse.json({ error: 'Text is required' }, { status: 400 });
    }

    const voiceId: VoiceId = VOICE_MAP[voice.name || ''] || DEFAULT_VOICE;
    
    const cacheKey = getCacheKey(text, voiceId);
    const cached = ttsCache.get(cacheKey);
    if (cached && Date.now() - cached.cached_at < CACHE_TTL) {
      console.log('TTS cache hit:', { textLength: text.length, voiceId });
      return NextResponse.json({
        audio_base64: cached.audio_base64,
        mime_type: cached.mime_type,
        duration_estimate: Math.ceil(text.split(/\s+/).length / 2.5),
        from_cache: true,
      });
    }
    
    cleanCache();
    
    console.log('Polly TTS request:', { voiceId, engine: DEFAULT_ENGINE, textLength: text.length });

    let engine: Engine = DEFAULT_ENGINE;
    let audioBuffer: Buffer;

    try {
      const result = await getPollyClient().send(
        new SynthesizeSpeechCommand({
          Engine: engine,
          OutputFormat: 'mp3',
          Text: text,
          VoiceId: voiceId,
          SampleRate: '24000',
        })
      );

      if (!result.AudioStream) {
        throw new Error('No audio stream in Polly response');
      }

      audioBuffer = Buffer.from(await result.AudioStream.transformToByteArray());
    } catch (firstError: unknown) {
      const msg = firstError instanceof Error ? firstError.message : String(firstError);
      if (msg.includes('not supported') || msg.includes('ValidationException')) {
        console.log(`Generative engine not supported for ${voiceId}, falling back to neural`);
        engine = 'neural';
        const result = await getPollyClient().send(
          new SynthesizeSpeechCommand({
            Engine: engine,
            OutputFormat: 'mp3',
            Text: text,
            VoiceId: voiceId,
            SampleRate: '24000',
          })
        );
        if (!result.AudioStream) {
          throw new Error('No audio stream in Polly response');
        }
        audioBuffer = Buffer.from(await result.AudioStream.transformToByteArray());
      } else {
        throw firstError;
      }
    }

    const audioBase64 = audioBuffer.toString('base64');
    const mimeType = 'audio/mpeg';

    console.log('TTS generated successfully:', { engine, voiceId, audioSize: audioBuffer.length });

    let audioUrl: string | undefined;
    if (save_to_storage && storage_path) {
      const supabase = createServerClient();
      
      const { error: uploadError } = await supabase.storage
        .from('audio-narrations')
        .upload(storage_path, audioBuffer, {
          contentType: mimeType,
          upsert: true,
        });

      if (uploadError) {
        console.error('Failed to upload audio:', uploadError);
      } else {
        const { data: urlData } = supabase.storage
          .from('audio-narrations')
          .getPublicUrl(storage_path);
        audioUrl = urlData.publicUrl;
      }
    }

    ttsCache.set(cacheKey, {
      audio_base64: audioBase64,
      mime_type: mimeType,
      cached_at: Date.now(),
    });

    return NextResponse.json({
      audio_base64: audioBase64,
      audio_url: audioUrl,
      mime_type: mimeType,
      duration_estimate: Math.ceil(text.split(/\s+/).length / 2.5),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('TTS error:', message, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
