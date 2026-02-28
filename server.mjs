import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { WebSocketServer } from 'ws';
import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { NodeHttp2Handler } from '@smithy/node-http-handler';

const dev = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.PORT || '3000', 10);
const app = next({ dev });
const handle = app.getRequestHandler();

const NOVA_SONIC_MODEL_ID = process.env.NOVA_SONIC_MODEL_ID || 'amazon.nova-sonic-v2:0';

function createBedrockClient() {
  return new BedrockRuntimeClient({
    region: process.env.AWS_REGION || 'us-east-1',
    requestHandler: new NodeHttp2Handler({
      requestTimeout: 300_000,
      sessionTimeout: 300_000,
      disableConcurrentStreams: false,
      maxConcurrentStreams: 20,
    }),
  });
}

// ---------------------------------------------------------------------------
// Nova Sonic bidirectional stream session (per WebSocket connection)
// ---------------------------------------------------------------------------

class SonicProxy {
  constructor(ws, config) {
    this.ws = ws;
    this.config = config;
    this.active = false;
    this.inputQueue = [];
    this.inputResolve = null;
    this.contentId = 0;
  }

  async start() {
    this.active = true;
    const self = this;
    const enc = new TextEncoder();

    async function* inputStream() {
      // Session start
      yield {
        chunk: {
          bytes: enc.encode(JSON.stringify({
            event: {
              sessionStart: {
                inferenceConfiguration: {
                  maxTokens: 1024,
                  topP: 0.9,
                  temperature: 0.7,
                },
              },
            },
          })),
        },
      };
      await delay(30);

      // System prompt
      if (self.config.systemInstruction) {
        const cid = `system-${self.contentId++}`;
        yield {
          chunk: {
            bytes: enc.encode(JSON.stringify({
              event: {
                contentStart: {
                  role: 'SYSTEM',
                  contentId: cid,
                  type: 'TEXT',
                  textInputConfiguration: { mediaType: 'text/plain' },
                },
              },
            })),
          },
        };
        await delay(15);

        yield {
          chunk: {
            bytes: enc.encode(JSON.stringify({
              event: { textInput: { contentId: cid, content: self.config.systemInstruction } },
            })),
          },
        };
        await delay(15);

        yield {
          chunk: {
            bytes: enc.encode(JSON.stringify({
              event: { contentEnd: { contentId: cid } },
            })),
          },
        };
        await delay(15);
      }

      // Yield queued events until session ends
      while (self.active) {
        if (self.inputQueue.length > 0) {
          const event = self.inputQueue.shift();
          yield { chunk: { bytes: enc.encode(JSON.stringify(event)) } };
          await delay(5);
        } else {
          await new Promise((resolve) => {
            self.inputResolve = resolve;
          });
        }
      }

      yield {
        chunk: {
          bytes: enc.encode(JSON.stringify({ event: { sessionEnd: {} } })),
        },
      };
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
        if (!event.chunk?.bytes) continue;

        try {
          const json = JSON.parse(dec.decode(event.chunk.bytes));

          if (json.event?.audioOutput) {
            this.send({ type: 'audio', data: json.event.audioOutput.content });
          } else if (json.event?.textOutput) {
            const role = json.event.textOutput.role === 'USER' ? 'user' : 'assistant';
            this.send({ type: 'text', role, content: json.event.textOutput.content });
          } else if (json.event?.completionEnd) {
            this.send({ type: 'turnComplete' });
          } else if (json.event?.sessionEnd) {
            this.send({ type: 'sessionEnd' });
          }
        } catch {
          // skip unparseable chunks
        }
      }
    } catch (error) {
      console.error('[Nova Sonic] Stream error:', error.message);
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
    if (!this.active) return;
    const cid = `audio-${this.contentId++}`;
    this.enqueue({
      event: {
        contentStart: {
          role: 'USER',
          contentId: cid,
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
    this.enqueue({ event: { audioInput: { contentId: cid, content: base64 } } });
    this.enqueue({ event: { contentEnd: { contentId: cid } } });
  }

  sendText(text) {
    if (!this.active) return;
    const cid = `text-${this.contentId++}`;
    this.enqueue({
      event: {
        contentStart: {
          role: 'USER',
          contentId: cid,
          type: 'TEXT',
          textInputConfiguration: { mediaType: 'text/plain' },
        },
      },
    });
    this.enqueue({ event: { textInput: { contentId: cid, content: text } } });
    this.enqueue({ event: { contentEnd: { contentId: cid } } });
  }

  send(msg) {
    if (this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  stop() {
    this.active = false;
    if (this.inputResolve) {
      this.inputResolve();
      this.inputResolve = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

app.prepare().then(() => {
  const server = createServer((req, res) => {
    handle(req, res, parse(req.url, true));
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const pathname = parse(request.url).pathname;
    if (pathname === '/api/nova-sonic/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    console.log('[Nova Sonic] WebSocket client connected');
    let proxy = null;

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        switch (msg.type) {
          case 'setup': {
            const config = {
              systemInstruction: msg.config?.systemInstruction || 'You are EVA, a warm and friendly AI companion.',
              voiceId: msg.config?.voiceId || 'tiffany',
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
            if (proxy) proxy.sendText(msg.content);
            break;

          case 'context':
            if (proxy) proxy.sendText(`[CONTEXT] ${msg.content}`);
            break;

          case 'imageContext':
            if (proxy) {
              proxy.sendText(`[CONTEXT] I'm looking at a photo. Here is what it shows: ${msg.description}`);
              if (msg.userText) proxy.sendText(msg.userText);
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
      console.log('[Nova Sonic] WebSocket client disconnected');
      if (proxy) proxy.stop();
    });

    ws.on('error', (err) => {
      console.error('[Nova Sonic] WebSocket error:', err);
      if (proxy) proxy.stop();
    });
  });

  server.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`);
    console.log(`> Nova Sonic WebSocket at ws://localhost:${port}/api/nova-sonic/ws`);
  });
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
