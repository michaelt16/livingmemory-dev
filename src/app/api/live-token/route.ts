/**
 * POST /api/live-token
 *
 * For Nova 2 Sonic, AWS credentials stay server-side.
 * Returns proxy endpoint so the client connects to our WebSocket at /api/nova-sonic/ws.
 */
export async function POST() {
  try {
    return Response.json({
      provider: 'nova-sonic',
      wsEndpoint: '/api/nova-sonic/ws',
      apiKey: 'server-managed',
    });
  } catch (error) {
    console.error('Failed to get auth token:', error);
    return Response.json(
      { error: 'Failed to get token' },
      { status: 500 }
    );
  }
}
