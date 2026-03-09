/**
 * Nova 2 Sonic Server-Side Session Manager
 *
 * Wraps the Bedrock InvokeModelWithBidirectionalStream API.
 * Designed to run on the server and be proxied to browser clients via
 * WebSocket (Socket.IO, custom WS server, etc.).
 *
 * Architecture:
 *   Browser (Web Audio API)  <-->  Server Proxy  <-->  Bedrock Nova Sonic
 *          PCM 16kHz mono           WebSocket        Bidirectional Stream
 *
 * IMPORTANT: Nova 2 Sonic is audio-only. Unlike Gemini Live, it does NOT
 * accept image/video frames during a conversation. To discuss a photo,
 * pre-analyze it with Nova 2 Lite and inject the description as text context.
 */

import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { NodeHttp2Handler } from '@smithy/node-http-handler';

const NOVA_SONIC_MODEL_ID = process.env.NOVA_SONIC_MODEL_ID || 'amazon.nova-2-sonic-v1:0';

export interface NovaSonicCallbacks {
  onAudio?: (audioBase64: string) => void;
  onText?: (text: string, role: 'user' | 'assistant') => void;
  onError?: (error: Error) => void;
  onTurnComplete?: () => void;
  onSessionEnd?: () => void;
}

export interface NovaSonicConfig {
  systemPrompt?: string;
  voiceId?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
}

let bedrockClient: BedrockRuntimeClient | null = null;

function getClient(): BedrockRuntimeClient {
  if (!bedrockClient) {
    bedrockClient = new BedrockRuntimeClient({
      region: process.env.AWS_REGION || 'us-east-1',
      requestHandler: new NodeHttp2Handler({
        requestTimeout: 300_000,
        sessionTimeout: 300_000,
        disableConcurrentStreams: false,
        maxConcurrentStreams: 20,
      }),
    });
  }
  return bedrockClient;
}

export class NovaSonicSession {
  private callbacks: NovaSonicCallbacks;
  private config: NovaSonicConfig;
  private isActive = false;
  private inputQueue: Array<Record<string, unknown>> = [];
  private inputResolve: ((value: void) => void) | null = null;
  private contentIdCounter = 0;

  constructor(config: NovaSonicConfig = {}, callbacks: NovaSonicCallbacks = {}) {
    this.config = {
      systemPrompt: 'You are EVA, a warm and friendly AI companion helping someone explore and share memories through photos. Keep responses conversational and brief.',
      voiceId: 'tiffany',
      maxTokens: 1024,
      temperature: 0.7,
      topP: 0.9,
      ...config,
    };
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    this.isActive = true;
    const self = this;

    async function* generateInputStream() {
      const textEncoder = new TextEncoder();

      const sessionStart = {
        event: {
          sessionStart: {
            inferenceConfiguration: {
              maxTokens: self.config.maxTokens,
              topP: self.config.topP,
              temperature: self.config.temperature,
            },
          },
        },
      };
      yield { chunk: { bytes: textEncoder.encode(JSON.stringify(sessionStart)) } };
      await delay(30);

      if (self.config.systemPrompt) {
        const systemContentId = `system-${self.contentIdCounter++}`;
        const systemStart = {
          event: {
            contentStart: {
              role: 'SYSTEM',
              contentId: systemContentId,
              type: 'TEXT',
              textInputConfiguration: { mediaType: 'text/plain' },
            },
          },
        };
        yield { chunk: { bytes: textEncoder.encode(JSON.stringify(systemStart)) } };
        await delay(15);

        const systemText = {
          event: {
            textInput: {
              contentId: systemContentId,
              content: self.config.systemPrompt,
            },
          },
        };
        yield { chunk: { bytes: textEncoder.encode(JSON.stringify(systemText)) } };
        await delay(15);

        const systemEnd = {
          event: { contentEnd: { contentId: systemContentId } },
        };
        yield { chunk: { bytes: textEncoder.encode(JSON.stringify(systemEnd)) } };
        await delay(15);
      }

      while (self.isActive) {
        if (self.inputQueue.length > 0) {
          const event = self.inputQueue.shift()!;
          yield { chunk: { bytes: textEncoder.encode(JSON.stringify(event)) } };
          await delay(5);
        } else {
          await new Promise<void>((resolve) => {
            self.inputResolve = resolve;
          });
        }
      }

      const sessionEnd = { event: { sessionEnd: {} } };
      yield { chunk: { bytes: textEncoder.encode(JSON.stringify(sessionEnd)) } };
    }

    const command = new InvokeModelWithBidirectionalStreamCommand({
      modelId: NOVA_SONIC_MODEL_ID,
      body: generateInputStream(),
    });

    try {
      const response = await getClient().send(command);
      if (response.body) {
        this.processResponses(response as { body: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }> });
      } else {
        throw new Error('No response body from Nova Sonic');
      }
    } catch (error) {
      this.isActive = false;
      const err = error instanceof Error ? error : new Error(String(error));
      this.callbacks.onError?.(err);
    }
  }

  private async processResponses(response: { body: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }> }): Promise<void> {
    const textDecoder = new TextDecoder();
    try {
      for await (const event of response.body) {
        if (!this.isActive) break;
        if (!event.chunk?.bytes) continue;

        try {
          const text = textDecoder.decode(event.chunk.bytes);
          const json = JSON.parse(text);

          if (json.event?.audioOutput) {
            this.callbacks.onAudio?.(json.event.audioOutput.content);
          } else if (json.event?.textOutput) {
            const role = json.event.textOutput.role === 'USER' ? 'user' : 'assistant';
            this.callbacks.onText?.(json.event.textOutput.content, role);
          } else if (json.event?.completionEnd) {
            this.callbacks.onTurnComplete?.();
          } else if (json.event?.sessionEnd) {
            this.callbacks.onSessionEnd?.();
          }
        } catch {
          // skip unparseable chunks
        }
      }
    } catch (error) {
      if (this.isActive) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.callbacks.onError?.(err);
      }
    } finally {
      this.isActive = false;
    }
  }

  private enqueue(event: Record<string, unknown>): void {
    this.inputQueue.push(event);
    if (this.inputResolve) {
      this.inputResolve();
      this.inputResolve = null;
    }
  }

  sendAudio(audioBase64: string): void {
    if (!this.isActive) return;
    const contentId = `audio-${this.contentIdCounter++}`;

    this.enqueue({
      event: {
        contentStart: {
          role: 'USER',
          contentId,
          type: 'AUDIO',
          audioInputConfiguration: {
            mediaType: 'audio/lpcm',
            sampleRateHertz: 16000,
            sampleSizeBits: 16,
            channelCount: 1,
            audioType: 'SPEECH',
            encoding: 'base64',
          },
        },
      },
    });

    this.enqueue({
      event: { audioInput: { contentId, content: audioBase64 } },
    });

    this.enqueue({
      event: { contentEnd: { contentId } },
    });
  }

  sendText(text: string): void {
    if (!this.isActive) return;
    const contentId = `text-${this.contentIdCounter++}`;

    this.enqueue({
      event: {
        contentStart: {
          role: 'USER',
          contentId,
          type: 'TEXT',
          textInputConfiguration: { mediaType: 'text/plain' },
        },
      },
    });

    this.enqueue({
      event: { textInput: { contentId, content: text } },
    });

    this.enqueue({
      event: { contentEnd: { contentId } },
    });
  }

  /**
   * Since Nova Sonic doesn't support image input, pre-analyze the image
   * with Nova 2 Lite and inject the description as text context.
   */
  async sendImageContext(imageDescription: string): Promise<void> {
    this.sendText(`[CONTEXT] I'm looking at a photo. Here is what it shows: ${imageDescription}`);
  }

  stop(): void {
    this.isActive = false;
    if (this.inputResolve) {
      this.inputResolve();
      this.inputResolve = null;
    }
  }

  get active(): boolean {
    return this.isActive;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
