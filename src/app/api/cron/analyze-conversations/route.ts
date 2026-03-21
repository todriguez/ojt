import { NextRequest, NextResponse } from 'next/server';

// This endpoint can be called by a cron service (like Vercel Cron, Uptime Robot, etc.)
// to periodically analyze conversations every 15 minutes

export async function GET(request: NextRequest) {
  try {
    // Verify the request is from a cron service (basic auth)
    const authHeader = request.headers.get('authorization');
    const expectedToken = process.env.CRON_SECRET || 'fallback-secret';

    if (authHeader !== `Bearer ${expectedToken}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    console.log('Running scheduled conversation analysis...');

    // Call the conversation analysis endpoint
    const analysisResponse = await fetch(`${process.env.VERCEL_URL || 'http://localhost:3000'}/api/analyze-conversations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const result = await analysisResponse.json();

    console.log('Conversation analysis completed:', result);

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      result: result
    });

  } catch (error) {
    console.error('Cron job error:', error);
    return NextResponse.json(
      { error: 'Failed to run conversation analysis', details: error },
      { status: 500 }
    );
  }
}

// Also allow POST for manual triggering
export async function POST(request: NextRequest) {
  return GET(request);
}