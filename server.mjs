import { readFileSync } from 'fs';
import { createServer } from 'http';
import { parse } from 'url';
import { randomUUID } from 'crypto';
import next from 'next';
import { WebSocketServer } from 'ws';
import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { NodeHttp2Handler } from '@smithy/node-http-handler';

// Load .env.local before anything else (node doesn't do this automatically)
try {
  const envContent = readFileSync('.env.local', 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    const val = trimmed.substring(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* no .env.local */ }

const dev = process.env.NODE_ENV !== 'production';
const hostname = 'localhost';
const port = parseInt(process.env.PORT || '3000', 10);
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const NOVA_SONIC_MODEL_ID = process.env.NOVA_SONIC_MODEL_ID || 'amazon.nova-2-sonic-v1:0';
console.log('[Nova Sonic] Model:', NOVA_SONIC_MODEL_ID);
console.log('[Nova Sonic] Region:', process.env.AWS_REGION || 'us-east-1');
console.log('[Nova Sonic] AWS Key:', process.env.AWS_ACCESS_KEY_ID ? process.env.AWS_ACCESS_KEY_ID.substring(0, 8) + '...' : 'MISSING');

function createBedrockClient() {
  return new BedrockRuntimeClient({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
    requestHandler: new NodeHttp2Handler({
      requestTimeout: 300_000,
      sessionTimeout: 300_000,
      disableConcurrentStreams: false,
      maxConcurrentStreams: 20,
    }),
  });
}

// ---------------------------------------------------------------------------
// Nova 2 Sonic bidirectional stream proxy (one per WebSocket connection)
//
// Protocol reference:
// https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-input-events.html
// ---------------------------------------------------------------------------

class SonicProxy {
  constructor(ws, config) {
    this.ws = ws;
    this.config = config;
    this.active = false;
    this.inputQueue = [];
    this.inputResolve = null;
    this.promptName = randomUUID();
    this.audioContentName = null;
    this.keepaliveInterval = null;
  }

  async start() {
    this.active = true;
    const self = this;
    const enc = new TextEncoder();

    async function* inputStream() {
      // 1. sessionStart
      yield chunk(enc, {
        event: {
          sessionStart: {
            inferenceConfiguration: {
              maxTokens: 1024,
              topP: 0.9,
              temperature: 0.7,
            },
            turnDetectionConfiguration: {
              endpointingSensitivity: 'MEDIUM',
            },
          },
        },
      });
      await delay(30);

      // 2. promptStart — defines voice, output format
      yield chunk(enc, {
        event: {
          promptStart: {
            promptName: self.promptName,
            textOutputConfiguration: { mediaType: 'text/plain' },
            audioOutputConfiguration: {
              mediaType: 'audio/lpcm',
              sampleRateHertz: 24000,
              sampleSizeBits: 16,
              channelCount: 1,
              voiceId: self.config.voiceId || 'tiffany',
              encoding: 'base64',
              audioType: 'SPEECH',
            },
          },
        },
      });
      await delay(15);

      // 3. System prompt
      if (self.config.systemInstruction) {
        const cn = randomUUID();
        yield chunk(enc, {
          event: {
            contentStart: {
              promptName: self.promptName,
              contentName: cn,
              type: 'TEXT',
              interactive: false,
              role: 'SYSTEM',
              textInputConfiguration: { mediaType: 'text/plain' },
            },
          },
        });
        await delay(10);

        yield chunk(enc, {
          event: {
            textInput: {
              promptName: self.promptName,
              contentName: cn,
              content: self.config.systemInstruction,
            },
          },
        });
        await delay(10);

        yield chunk(enc, {
          event: {
            contentEnd: {
              promptName: self.promptName,
              contentName: cn,
            },
          },
        });
        await delay(10);
      }

      // 4. Always open audio input stream (Nova Sonic needs it as interactive channel)
      self.audioContentName = randomUUID();
      yield chunk(enc, {
        event: {
          contentStart: {
            promptName: self.promptName,
            contentName: self.audioContentName,
            type: 'AUDIO',
            interactive: true,
            role: 'USER',
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
      await delay(10);

      // Send initial silence + periodic keepalive to prevent Nova's 55s inactivity timeout
      {
        const silenceChunk = Buffer.alloc(3200).toString('base64'); // 100ms of 16kHz 16-bit silence
        // Send immediate silence so Nova Sonic knows the audio channel is active
        yield chunk(enc, {
          event: {
            audioInput: {
              promptName: self.promptName,
              contentName: self.audioContentName,
              content: silenceChunk,
            },
          },
        });
        await delay(5);

        // Periodic keepalive every 25s
        self.keepaliveInterval = setInterval(() => {
          if (!self.active) return;
          self.enqueue({
            event: {
              audioInput: {
                promptName: self.promptName,
                contentName: self.audioContentName,
                content: silenceChunk,
              },
            },
          });
        }, 25_000);
      }

      // 5. Yield queued events until session ends
      while (self.active) {
        if (self.inputQueue.length > 0) {
          const event = self.inputQueue.shift();
          yield chunk(enc, event);
          await delay(2);
        } else {
          await new Promise((resolve) => {
            self.inputResolve = resolve;
          });
        }
      }

      // 6. Close audio stream → promptEnd → sessionEnd
      if (self.keepaliveInterval) clearInterval(self.keepaliveInterval);
      yield chunk(enc, {
        event: {
          contentEnd: {
            promptName: self.promptName,
            contentName: self.audioContentName,
          },
        },
      });
      await delay(10);

      yield chunk(enc, {
        event: { promptEnd: { promptName: self.promptName } },
      });
      await delay(10);

      yield chunk(enc, { event: { sessionEnd: {} } });
    }

    const command = new InvokeModelWithBidirectionalStreamCommand({
      modelId: NOVA_SONIC_MODEL_ID,
      body: inputStream(),
    });

    try {
      const client = createBedrockClient();
      const response = await client.send(command);

      if (!response.body) throw new Error('No response body from Nova Sonic');

      this.send({ type: 'ready' });

      const dec = new TextDecoder();
      for await (const event of response.body) {
        if (!this.active) break;

        if (event.chunk?.bytes) {
          try {
            const json = JSON.parse(dec.decode(event.chunk.bytes));
            const e = json.event;
            if (!e) continue;

            if (e.audioOutput) {
              console.log('[Nova Sonic] Audio output chunk received');
              this.send({ type: 'audio', data: e.audioOutput.content });
            } else if (e.textOutput) {
              const content = e.textOutput.content || '';
              const role = e.textOutput.role === 'USER' ? 'user' : 'assistant';
              const isInterruptedJson = /^\s*\{\s*["']interrupted["']\s*:\s*true\s*\}\s*$/i.test(content.trim());
              if (isInterruptedJson) {
                this.send({ type: 'interrupted' });
                continue;
              }
              if (content.trim()) {
                console.log(`[Nova Sonic] Text output (${role}):`, content.substring(0, 80));
                this.send({ type: 'text', role, content });
              }
            } else if (e.contentStart) {
              console.log('[Nova Sonic] Content start:', e.contentStart.type, e.contentStart.role);
            } else if (e.contentEnd) {
              console.log('[Nova Sonic] Content end, stopReason:', e.contentEnd.stopReason);
              if (e.contentEnd.stopReason === 'END_TURN') {
                this.send({ type: 'turnComplete' });
              }
            } else if (e.completionEnd) {
              console.log('[Nova Sonic] Completion end');
              this.send({ type: 'turnComplete' });
            } else if (e.sessionEnd) {
              console.log('[Nova Sonic] Session end');
              this.send({ type: 'sessionEnd' });
            } else {
              console.log('[Nova Sonic] Other event:', Object.keys(e).join(', '));
            }
          } catch {
            // skip unparseable chunks
          }
        } else if (event.modelStreamErrorException) {
          console.error('[Nova Sonic] Model stream error:', event.modelStreamErrorException);
          this.send({ type: 'error', message: event.modelStreamErrorException.message || 'Model stream error' });
        } else if (event.internalServerException) {
          console.error('[Nova Sonic] Internal server error:', event.internalServerException);
          this.send({ type: 'error', message: event.internalServerException.message || 'Internal server error' });
        }
      }
    } catch (error) {
      console.error('[Nova Sonic] Stream error:', error.message);
      console.error('[Nova Sonic] Error name:', error.name);
      console.error('[Nova Sonic] Error code:', error.$metadata?.httpStatusCode);
      if (error.$response) {
        try {
          const body = error.$response.body;
          if (body) console.error('[Nova Sonic] Raw response body available');
        } catch {}
      }
      console.error('[Nova Sonic] Full error keys:', Object.keys(error));
      this.send({ type: 'error', message: error.message });
    } finally {
      this.active = false;
    }
  }

  enqueue(event) {
    this.inputQueue.push(event);
    if (this.inputResolve) {
      this.inputResolve();
      this.inputResolve = null;
    }
  }

  sendAudio(base64) {
    if (!this.active || !this.audioContentName) return;
    this.enqueue({
      event: {
        audioInput: {
          promptName: this.promptName,
          contentName: this.audioContentName,
          content: base64,
        },
      },
    });
  }

  sendText(text, interactive = true) {
    if (!this.active) return;

    // In textOnly mode, close the audio stream before sending text,
    // then reopen it afterward — this is the documented pattern for
    // switching from audio to text input in Nova Sonic.
    if (this.config.textOnly && this.audioContentName && interactive) {
      // Close audio stream
      this.enqueue({
        event: {
          contentEnd: {
            promptName: this.promptName,
            contentName: this.audioContentName,
          },
        },
      });
    }

    const cn = randomUUID();
    this.enqueue({
      event: {
        contentStart: {
          promptName: this.promptName,
          contentName: cn,
          type: 'TEXT',
          interactive,
          role: 'USER',
          textInputConfiguration: { mediaType: 'text/plain' },
        },
      },
    });
    this.enqueue({
      event: {
        textInput: {
          promptName: this.promptName,
          contentName: cn,
          content: text,
        },
      },
    });
    this.enqueue({
      event: {
        contentEnd: {
          promptName: this.promptName,
          contentName: cn,
        },
      },
    });

    // Reopen audio stream so Nova Sonic stays active
    if (this.config.textOnly && interactive) {
      const newAudioCn = randomUUID();
      this.audioContentName = newAudioCn;
      this.enqueue({
        event: {
          contentStart: {
            promptName: this.promptName,
            contentName: newAudioCn,
            type: 'AUDIO',
            interactive: true,
            role: 'USER',
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
      // Send a bit of silence on the new stream to keep it alive
      const silenceChunk = Buffer.alloc(3200).toString('base64');
      this.enqueue({
        event: {
          audioInput: {
            promptName: this.promptName,
            contentName: newAudioCn,
            content: silenceChunk,
          },
        },
      });
    }
  }

  send(msg) {
    if (this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  stop() {
    this.active = false;
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
    if (this.inputResolve) {
      this.inputResolve();
      this.inputResolve = null;
    }
  }
}

function chunk(enc, obj) {
  return { chunk: { bytes: enc.encode(JSON.stringify(obj)) } };
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

app.prepare().then(() => {
  const server = createServer((req, res) => {
    handle(req, res, parse(req.url, true));
  });

  const wss = new WebSocketServer({ noServer: true });

  // Next.js exposes an upgrade handler for HMR WebSockets in dev mode
  const nextUpgradeHandler = typeof app.getUpgradeHandler === 'function'
    ? app.getUpgradeHandler()
    : null;

  server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url, `http://${request.headers.host}`);
    if (pathname === '/api/nova-sonic/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else if (nextUpgradeHandler) {
      nextUpgradeHandler(request, socket, head);
    }
  });

  wss.on('connection', (ws) => {
    console.log('[Nova Sonic] Client connected');
    let proxy = null;
    let lastPhotoContextHash = '';

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        switch (msg.type) {
          case 'setup': {
            const config = {
              systemInstruction: msg.config?.systemInstruction || 'You are EVA, a warm and friendly AI companion helping someone explore and share memories through photos. Keep responses conversational and brief.',
              voiceId: msg.config?.voiceId || 'tiffany',
              textOnly: !!msg.config?.textOnly,
            };
            proxy = new SonicProxy(ws, config);
            proxy.start().catch((err) => {
              console.error('[Nova Sonic] Session error:', err);
            });
            break;
          }

          case 'audio':
            if (proxy) proxy.sendAudio(msg.data);
            break;

          case 'text':
            console.log('[Nova Sonic] Text received:', (msg.content || '').substring(0, 60));
            if (proxy) proxy.sendText(msg.content);
            break;

          case 'context': {
            const ctx = msg.content || '';
            console.log('[Nova Sonic] Context (non-interactive):', ctx.substring(0, 150));
            // All context is non-interactive — EVA remembers but doesn't respond.
            // She will reference it naturally when the user speaks next.
            if (proxy) proxy.sendText(`[CONTEXT] ${ctx}`, false);
            break;
          }

          case 'imageContext':
            console.log('[Nova Sonic] Image context:', (msg.description || '').substring(0, 200));
            if (proxy) {
              // Brief acknowledgment — EVA should mention 1 detail then WAIT for user to talk
              const photoContext = `[PHOTO DESCRIPTION: ${msg.description}] Say ONE short sentence acknowledging the photo — mention one specific thing you notice. Then ask a single open question like "Tell me about this moment" and STOP. Do NOT describe the whole photo. Keep it under 20 words total.`;
              proxy.sendText(photoContext);
            }
            break;

          default:
            console.log('[Nova Sonic] Unknown message type:', msg.type);
        }
      } catch (err) {
        console.error('[Nova Sonic] Message parse error:', err);
      }
    });

    ws.on('close', () => {
      console.log('[Nova Sonic] Client disconnected');
      if (proxy) proxy.stop();
    });

    ws.on('error', (err) => {
      console.error('[Nova Sonic] WebSocket error:', err);
      if (proxy) proxy.stop();
    });
  });

  server.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`);
    console.log(`> Nova Sonic WS at ws://localhost:${port}/api/nova-sonic/ws`);
  });
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
