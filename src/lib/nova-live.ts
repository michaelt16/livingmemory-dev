/**
 * Nova Live Client for Browser
 *
 * Drop-in replacement for GeminiLiveClient that routes voice conversations
 * through a server-side proxy to Amazon Nova 2 Sonic.
 *
 * Vision workaround:
 * Nova Sonic is audio-only — it can't see images. To simulate Gemini Live's
 * multimodal vision, this client intercepts image/frame inputs and:
 *
 * 1. sendTextWithImage() → Analyzes image via Nova 2 Lite, sends description
 *    as text context to the voice session. EVA "sees" the photo through
 *    the analysis — people, setting, era, mood, visual details.
 *
 * 2. sendVideoFrame() → Detects when a NEW photo appears in camera frames.
 *    Debounces and only analyzes when something meaningful changes (not every
 *    frame). Injects the analysis as background context so EVA stays aware
 *    of what's on screen without being told explicitly.
 *
 * Result: EVA can still say "I see Roberto in a striped shirt" — she just
 * gets that from a text analysis pipeline instead of direct vision.
 */

export interface LiveConfig {
  model?: string;
  systemInstruction?: string;
  voiceId?: string;
  /** When true, no microphone/audio input — TTS only (avoids Nova's 55s "waiting for audio" timeout) */
  textOnly?: boolean;
  responseModalities?: ('AUDIO' | 'TEXT')[];
  speechConfig?: {
    voiceConfig?: {
      prebuiltVoiceConfig?: {
        voiceName?: string;
      };
    };
  };
}

export interface LiveMessage {
  type: 'user' | 'model' | 'system';
  content: string;
  timestamp: number;
  audioData?: string;
}

export interface LiveCallbacks {
  onConnect?: () => void;
  onDisconnect?: () => void;
  onMessage?: (message: LiveMessage) => void;
  onAudio?: (audioData: ArrayBuffer) => void;
  onError?: (error: Error) => void;
  onInterrupted?: () => void;
  onTurnComplete?: () => void;
  onProcessingPhoto?: (processing: boolean) => void;
}

/**
 * Deep photo analysis prompt for dedicated photo conversations.
 * Produces a rich 8-10 sentence description that gives EVA enough context
 * to have a meaningful, detailed conversation about the photo.
 */
export const DEEP_PHOTO_ANALYSIS_PROMPT = `Analyze this photograph in thorough detail (8-10 sentences). Cover ALL of the following:

PEOPLE: Exact number of people visible. For each person, describe their approximate age, gender, ethnicity if apparent, clothing (colors, style), facial expression, body language, and posture. Note if people are touching, embracing, or positioned in ways that suggest relationships (parent-child, couple, friends, etc).

SETTING: Describe the specific location — indoors or outdoors? If indoors, what type of room (living room, restaurant, church, etc)? If outdoors, describe the landscape, weather, time of day. Note the lighting quality (natural, flash, ambient). Describe background details — wall decorations, furniture, trees, buildings, sky.

OBJECTS & DETAILS: Any food, drinks, cake, gifts, decorations, balloons, flowers, signs, banners, or text visible. Any pets or animals. Any notable objects people are holding or wearing (jewelry, hats, costumes, uniforms).

ERA & CONTEXT: Estimate the decade or era based on clothing styles, hair styles, photo quality, and visible technology. What type of event or occasion does this appear to be (birthday, wedding, holiday, casual gathering, formal event, vacation)?

MOOD: Describe the overall emotional tone — joyful, solemn, casual, formal, chaotic, serene? What makes this moment feel significant or worth preserving?

Be extremely concrete and specific. Say "a woman in her 60s with silver hair wearing a red cardigan, smiling broadly with her arm around a boy of about 8 in a striped blue t-shirt" NOT "some people together."`;

export class NovaLiveClient {
  private ws: WebSocket | null = null;
  private config: LiveConfig;
  private callbacks: LiveCallbacks;
  private isConnected: boolean = false;
  private audioQueue: ArrayBuffer[] = [];
  private playbackContext: AudioContext | null = null;
  private nextPlayTime: number = 0;
  private modelResponseBuffer: string = '';
  private userResponseBuffer: string = '';
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;

  // Vision workaround state
  private lastAnalyzedFrame: string = '';
  private lastAnalysisResult: string = '';
  private frameAnalysisInFlight: boolean = false;
  private frameDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private frameCount: number = 0;
  private hasInjectedPhotoContext: boolean = false;
  private _discussingPhoto: boolean = false;

  constructor(_apiKey: string, config: LiveConfig = {}, callbacks: LiveCallbacks = {}) {
    this.config = {
      systemInstruction: 'You are a helpful, friendly AI assistant helping someone explore and share memories through photos. Keep responses conversational and brief.',
      ...config,
    };
    this.callbacks = callbacks;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/api/nova-sonic/ws`;

        this.ws = new WebSocket(wsUrl);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
          console.log('Connected to Nova Sonic proxy');
          const setup = {
            type: 'setup',
            config: {
              systemInstruction: this.config.systemInstruction,
              voiceId: this.config.voiceId,
              textOnly: this.config.textOnly,
            },
          };
          this.ws!.send(JSON.stringify(setup));
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
          if (!this.isConnected) {
            this.isConnected = true;
            this.callbacks.onConnect?.();
            resolve();
          }
        };

        this.ws.onerror = (error) => {
          console.error('Nova Sonic WebSocket error:', error);
          this.callbacks.onError?.(new Error('WebSocket connection error'));
          reject(error);
        };

        this.ws.onclose = (event) => {
          console.log('Nova Sonic WebSocket closed:', event.code, event.reason);
          this.isConnected = false;
          this.callbacks.onDisconnect?.();
        };

        setTimeout(() => {
          if (!this.isConnected) {
            reject(new Error('Connection timeout'));
          }
        }, 15000);
      } catch (error) {
        reject(error);
      }
    });
  }

  private handleMessage(data: ArrayBuffer | string): void {
    try {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
      const message = JSON.parse(text);

      switch (message.type) {
        case 'ready':
          break;

        case 'audio':
          if (message.data) {
            const audioData = this.base64ToArrayBuffer(message.data);
            this.audioQueue.push(audioData);
            this.callbacks.onAudio?.(audioData);
            this.playQueuedAudio();
          }
          break;

        case 'text':
          if (message.role === 'user') {
            this.userResponseBuffer += message.content || '';
          } else {
            this.modelResponseBuffer += message.content || '';
          }
          break;

        case 'turnComplete': {
          const userText = this.userResponseBuffer.trim();
          const modelText = this.modelResponseBuffer.trim();
          this.userResponseBuffer = '';
          this.modelResponseBuffer = '';
          const isInterruptedJson = (s: string) => /^\s*\{\s*["']?interrupted["']?\s*:\s*true\s*\}\s*$/i.test(s) || s.includes('"interrupted"') && s.includes('true');
          if (userText && !isInterruptedJson(userText)) {
            this.callbacks.onMessage?.({
              type: 'user',
              content: userText,
              timestamp: Date.now(),
            });
          }
          if (modelText && !isInterruptedJson(modelText)) {
            this.callbacks.onMessage?.({
              type: 'model',
              content: modelText.replace(/\s*\{\s*["']?interrupted["']?\s*:\s*true\s*\}\s*/gi, '').trim(),
              timestamp: Date.now(),
            });
          }
          this.callbacks.onTurnComplete?.();
          break;
        }

        case 'error':
          this.callbacks.onError?.(new Error(message.message || 'Unknown error'));
          break;

        case 'interrupted':
          this.audioQueue = [];
          this.modelResponseBuffer = '';
          this.userResponseBuffer = '';
          this.callbacks.onInterrupted?.();
          break;
      }
    } catch (error) {
      console.error('Error parsing Nova Sonic message:', error);
    }
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  sendText(text: string): void {
    if (!this.ws || !this.isConnected) return;
    this.ws.send(JSON.stringify({ type: 'text', content: text }));
    this.callbacks.onMessage?.({
      type: 'user',
      content: text,
      timestamp: Date.now(),
    });
  }

  sendContext(context: string): void {
    if (!this.ws || !this.isConnected) return;
    this.ws.send(JSON.stringify({ type: 'context', content: context }));
    console.log('Context sent to Nova Sonic:', context.substring(0, 100) + '...');
  }

  /**
   * Analyze the image via Nova 2 Lite, then send the description + user text
   * to the voice session. EVA will respond as if she "saw" the photo.
   */
  async sendTextWithImage(text: string, imageDataUrl: string): Promise<void> {
    if (!this.ws || !this.isConnected) return;

    this.callbacks.onProcessingPhoto?.(true);
    try {
      const response = await fetch('/api/analyze-photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: imageDataUrl,
          prompt: 'Describe this photo in rich detail (4-5 sentences). Include: how many people are visible, their approximate ages, clothing, expressions, and body language. Describe the setting specifically (indoors/outdoors, room type, decorations, landscape). Note any food, objects, text, or signage. Describe the mood and what activity or event seems to be happening. Be concrete — say "three women in their 60s laughing around a dinner table" not "some people at a gathering".',
        }),
      });
      const data = await response.json();
      const description = data.response || (data.analysis ? JSON.stringify(data.analysis) : 'A photograph');

      console.log('[sendTextWithImage] Analysis result:', description.substring(0, 200));
      this.lastAnalysisResult = description;
      this.hasInjectedPhotoContext = true;

      this.ws.send(JSON.stringify({
        type: 'imageContext',
        description,
        userText: text,
      }));
    } catch (err) {
      console.error('[sendTextWithImage] Analysis failed:', err);
      this.ws.send(JSON.stringify({ type: 'text', content: text }));
    } finally {
      this.callbacks.onProcessingPhoto?.(false);
    }
  }

  sendAudio(audioData: ArrayBuffer): void {
    if (!this.ws || !this.isConnected) return;
    this.ws.send(JSON.stringify({
      type: 'audio',
      data: this.arrayBufferToBase64(audioData),
    }));
  }

  /**
   * Smart vision bridge for camera frames.
   *
   * Called every ~1.5s with camera/photo frames. Instead of sending every frame
   * to the model (impossible with Nova Sonic), this method:
   *
   * 1. Skips most frames — only analyzes every Nth frame to avoid spam
   * 2. Detects "new" content — compares frame signatures to avoid re-analyzing
   *    the same static photo repeatedly (story mode sends same frame every 1s)
   * 3. Analyzes in background — fires off a Nova 2 Lite analysis without
   *    blocking audio, then injects result as silent context
   * 4. First frame priority — always analyzes the very first frame immediately
   *    so EVA has context from the start
   */
  sendVideoFrame(frameData: string): void {
    if (!this.ws || !this.isConnected) return;
    if (this._discussingPhoto) return;

    this.frameCount++;

    // For story mode: same photo sent repeatedly — analyze once, skip the rest
    const frameSignature = frameData.substring(frameData.length - 200);
    if (frameSignature === this.lastAnalyzedFrame && this.hasInjectedPhotoContext) {
      return;
    }

    // First 2 frames: analyze immediately so EVA has context fast
    const isEarlyFrame = this.frameCount <= 2;

    // After early frames: analyze every 8th frame (~12 seconds) — just keep context fresh
    if (!isEarlyFrame && this.frameCount % 8 !== 0) {
      return;
    }

    // Don't stack up analyses
    if (this.frameAnalysisInFlight) return;

    // Debounce: minimal for early frames, longer for later
    if (this.frameDebounceTimer) {
      clearTimeout(this.frameDebounceTimer);
    }

    this.frameDebounceTimer = setTimeout(() => {
      this.analyzeFrameInBackground(frameData, frameSignature);
    }, isEarlyFrame ? 50 : 400);
  }

  private async analyzeFrameInBackground(
    frameData: string,
    frameSignature: string
  ): Promise<void> {
    if (this.frameAnalysisInFlight) return;
    this.frameAnalysisInFlight = true;
    this.callbacks.onProcessingPhoto?.(true);

    try {
      const quickPrompt = 'Describe this image in 3-4 vivid sentences as if telling a friend what you see. Include: exact number of people visible, approximate ages, what they are wearing, their expressions and body language, the specific setting (indoors/outdoors, room type, landscape), any food/decorations/objects visible, and the overall mood. If there is text or signage, read it. Be concrete and specific — avoid vague terms like "some people" or "a gathering".';

      const response = await fetch('/api/analyze-photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: frameData,
          prompt: quickPrompt,
        }),
      });

      if (!response.ok) return;

      const data = await response.json();
      const description = data.response || data.analysis
        ? (data.response || JSON.stringify(data.analysis))
        : null;

      if (!description) return;

      // Only inject if the description is meaningfully different
      if (description !== this.lastAnalysisResult) {
        this.lastAnalysisResult = description;
        this.lastAnalyzedFrame = frameSignature;
        this.hasInjectedPhotoContext = true;

        // Inject as silent context — EVA receives this but doesn't respond to it.
        // Next time the user speaks, EVA will naturally reference what she "sees".
        if (this.ws && this.isConnected) {
          this.ws.send(JSON.stringify({
            type: 'context',
            content: `[VISUAL CONTEXT - What I can see right now] ${description}`,
          }));
          console.log('[Vision Bridge] Injected frame context:', description.substring(0, 100));
        }
      }
    } catch (error) {
      console.error('[Vision Bridge] Frame analysis failed:', error);
    } finally {
      this.frameAnalysisInFlight = false;
      this.callbacks.onProcessingPhoto?.(false);
    }
  }

  async startMicrophone(): Promise<void> {
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      this.audioContext = new AudioContext({ sampleRate: 16000 });
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      const processor = this.audioContext.createScriptProcessor(4096, 1, 1);

      processor.onaudioprocess = (event) => {
        if (!this.isConnected) return;
        const inputData = event.inputBuffer.getChannelData(0);
        const pcmData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          pcmData[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
        }
        this.sendAudio(pcmData.buffer);
      };

      source.connect(processor);
      processor.connect(this.audioContext.destination);
      console.log('Microphone started');
    } catch (error) {
      console.error('Failed to start microphone:', error);
      throw error;
    }
  }

  stopMicrophone(): void {
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }

  private playQueuedAudio(): void {
    if (this.audioQueue.length === 0) return;

    try {
      if (!this.playbackContext || this.playbackContext.state === 'closed') {
        this.playbackContext = new AudioContext({ sampleRate: 24000 });
        this.nextPlayTime = this.playbackContext.currentTime;
      }

      const ctx = this.playbackContext;
      if (ctx.state === 'suspended') ctx.resume();

      while (this.audioQueue.length > 0) {
        const audioData = this.audioQueue.shift()!;
        const int16Data = new Int16Array(audioData);
        const float32Data = new Float32Array(int16Data.length);
        for (let i = 0; i < int16Data.length; i++) {
          float32Data[i] = int16Data[i] / 32768;
        }

        const audioBuffer = ctx.createBuffer(1, float32Data.length, 24000);
        audioBuffer.getChannelData(0).set(float32Data);

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);

        const startTime = Math.max(ctx.currentTime, this.nextPlayTime);
        source.start(startTime);
        this.nextPlayTime = startTime + audioBuffer.duration;
      }
    } catch (error) {
      console.error('Error playing audio:', error);
    }
  }

  disconnect(): void {
    this.stopMicrophone();
    if (this.frameDebounceTimer) {
      clearTimeout(this.frameDebounceTimer);
      this.frameDebounceTimer = null;
    }
    if (this.playbackContext && this.playbackContext.state !== 'closed') {
      this.playbackContext.close();
      this.playbackContext = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.audioQueue = [];
    this.modelResponseBuffer = '';
    this.userResponseBuffer = '';
    this.lastAnalyzedFrame = '';
    this.lastAnalysisResult = '';
    this.hasInjectedPhotoContext = false;
    this.frameCount = 0;
    this._discussingPhoto = false;
  }

  get connected(): boolean {
    return this.isConnected;
  }

  set discussingPhoto(val: boolean) {
    this._discussingPhoto = val;
  }

  get discussingPhoto(): boolean {
    return this._discussingPhoto;
  }
}

/**
 * Run a deep analysis of a photo BEFORE connecting to Nova Sonic.
 * Returns a rich 8-10 sentence description suitable for embedding in
 * the system instruction so EVA "knows" the photo from her first word.
 */
export async function deepAnalyzePhoto(imageDataUrl: string): Promise<string> {
  try {
    const response = await fetch('/api/analyze-photo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: imageDataUrl,
        prompt: DEEP_PHOTO_ANALYSIS_PROMPT,
      }),
    });
    if (!response.ok) throw new Error(`Analysis failed: ${response.status}`);
    const data = await response.json();
    return data.response || (data.analysis ? JSON.stringify(data.analysis) : '');
  } catch (err) {
    console.error('[deepAnalyzePhoto] Failed:', err);
    return '';
  }
}

export async function getAuthToken(): Promise<{ apiKey?: string; token?: string }> {
  try {
    const response = await fetch('/api/live-token', { method: 'POST' });
    return await response.json();
  } catch (error) {
    console.error('Failed to get auth token:', error);
    throw error;
  }
}
