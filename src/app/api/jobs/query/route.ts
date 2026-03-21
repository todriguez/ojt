import { NextRequest, NextResponse } from 'next/server';
import { jobQueryService } from '@/lib/jobQueryService';
import { Coordinates, SchedulingPreferences } from '@/types/job';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, ...params } = body;

    let result;

    switch (action) {
      case 'findJobsNear':
        result = await jobQueryService.findJobsNear(
          params.location as Coordinates,
          params.radiusKm
        );
        break;

      case 'getJobsBySuburb':
        result = await jobQueryService.getJobsBySuburb(params.suburb);
        break;

      case 'getJobsWithinTravelTime':
        result = await jobQueryService.getJobsWithinTravelTime(params.minutes);
        break;

      case 'optimizeRoute':
        result = await jobQueryService.optimizeRoute(
          params.startLocation as Coordinates,
          params.maxTravelTime
        );
        break;

      case 'findStackableJobs':
        result = await jobQueryService.findStackableJobs(params.baseJobId);
        break;

      case 'getQuickJobs':
        result = await jobQueryService.getQuickJobs(
          params.maxHours,
          params.location as Coordinates | undefined
        );
        break;

      case 'getJobsForTimeSlot':
        result = await jobQueryService.getJobsForTimeSlot(
          params.date,
          params.durationHours
        );
        break;

      case 'getHighProfitJobs':
        result = await jobQueryService.getHighProfitJobs(params.minScore);
        break;

      case 'getUrgentJobs':
        result = await jobQueryService.getUrgentJobs();
        break;

      case 'getPendingDecisions':
        result = await jobQueryService.getPendingDecisions();
        break;

      case 'findOptimalSchedule':
        result = await jobQueryService.findOptimalSchedule(
          params.availableHours,
          params.preferences as SchedulingPreferences
        );
        break;

      case 'checkDependencies':
        result = await jobQueryService.checkDependencies(params.jobId);
        break;

      default:
        return NextResponse.json(
          { error: 'Invalid action' },
          { status: 400 }
        );
    }

    return NextResponse.json(result);

  } catch (error) {
    console.error('Job query API error:', error);
    return NextResponse.json(
      { error: 'Failed to process job query' },
      { status: 500 }
    );
  }
}

// Helper endpoint for natural language queries
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');

  if (!query) {
    return NextResponse.json({ error: 'Query parameter required' }, { status: 400 });
  }

  try {
    // Process natural language queries
    const result = await processNaturalLanguageQuery(query);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Natural language query error:', error);
    return NextResponse.json(
      { error: 'Failed to process natural language query' },
      { status: 500 }
    );
  }
}

// Natural language query processor
async function processNaturalLanguageQuery(query: string) {
  const lowerQuery = query.toLowerCase();

  // Parse common patterns
  if (lowerQuery.includes('urgent') || lowerQuery.includes('emergency')) {
    return await jobQueryService.getUrgentJobs();
  }

  if (lowerQuery.includes('pending') || lowerQuery.includes('review')) {
    return await jobQueryService.getPendingDecisions();
  }

  if (lowerQuery.includes('near') || lowerQuery.includes('within')) {
    // Extract location and distance
    const locationMatch = lowerQuery.match(/(?:near|within)\s+(\d+)\s*(?:km|kilometers?)/);
    if (locationMatch) {
      const radiusKm = parseInt(locationMatch[1]);
      // For demo, use Noosa coordinates
      const noosaLocation: Coordinates = { lat: -26.3955, lng: 153.0937 };
      return await jobQueryService.findJobsNear(noosaLocation, radiusKm);
    }
  }

  if (lowerQuery.includes('quick') || lowerQuery.match(/\d+\s*hour/)) {
    // Extract hour count
    const hourMatch = lowerQuery.match(/(\d+)\s*hour/);
    const maxHours = hourMatch ? parseInt(hourMatch[1]) : 3; // Default 3 hours
    return await jobQueryService.getQuickJobs(maxHours);
  }

  if (lowerQuery.includes('suburb') || lowerQuery.includes('in ')) {
    // Extract suburb name
    const suburbMatch = lowerQuery.match(/(?:suburb|in\s+)([a-zA-Z\s]+)/);
    if (suburbMatch) {
      const suburb = suburbMatch[1].trim();
      return await jobQueryService.getJobsBySuburb(suburb);
    }
  }

  if (lowerQuery.includes('profit') || lowerQuery.includes('high value')) {
    // Look for high profit jobs
    return await jobQueryService.getHighProfitJobs(7); // Score of 7 or higher
  }

  // Default response for unrecognized queries
  return {
    error: 'Query not understood',
    suggestions: [
      'Try: "urgent jobs"',
      'Try: "jobs near 20km"',
      'Try: "3 hour jobs"',
      'Try: "jobs in Cooroy"',
      'Try: "high profit jobs"',
      'Try: "pending review"'
    ]
  };
}