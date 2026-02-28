/**
 * POST /api/live-token
 *
 * For Nova 2 Sonic, AWS credentials stay server-side.
 * This endpoint signals to the client that it should connect to our
 * WebSocket proxy at /api/nova-sonic/ws rather than directly to a provider.
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
