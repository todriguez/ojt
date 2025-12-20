import {
  JobSheet,
  JobQueryAPI,
  Coordinates,
  RouteOptimization,
  SchedulingPreferences,
  ScheduleSuggestion,
  DependencyStatus
} from '@/types/job';
import { getAllJobSheets } from './jobService';

// Base location for distance calculations (Noosa area)
const BASE_LOCATION: Coordinates = { lat: -26.3955, lng: 153.0937 };

// Implement the JobQueryAPI interface
export class JobQueryService implements JobQueryAPI {

  // Location-based queries
  async findJobsNear(location: Coordinates, radiusKm: number): Promise<JobSheet[]> {
    const allJobs = await getAllJobSheets();

    return allJobs.filter(job => {
      if (!job.customer.location.coordinates) return false;

      const distance = calculateDistance(location, job.customer.location.coordinates);
      return distance <= radiusKm;
    });
  }

  async getJobsBySuburb(suburb: string): Promise<JobSheet[]> {
    const allJobs = await getAllJobSheets();

    return allJobs.filter(job =>
      job.customer.location.suburb.toLowerCase().includes(suburb.toLowerCase())
    );
  }

  async getJobsWithinTravelTime(minutes: number): Promise<JobSheet[]> {
    const allJobs = await getAllJobSheets();

    return allJobs.filter(job => {
      if (!job.customer.location.travelTime && !job.customer.location.distanceFromBase) {
        return false; // Can't determine travel time
      }

      // Estimate travel time if not available (assuming 60km/h average)
      const estimatedTravelTime = job.customer.location.travelTime ||
        (job.customer.location.distanceFromBase! * 60 / 60); // distance / speed

      return estimatedTravelTime <= minutes;
    });
  }

  // Route optimization
  async optimizeRoute(startLocation: Coordinates, maxTravelTime: number): Promise<RouteOptimization> {
    const nearbyJobs = await this.findJobsNear(startLocation, maxTravelTime);

    // Simple route optimization - in production, use proper routing algorithm
    const sortedJobs = nearbyJobs.sort((a, b) => {
      const distA = a.customer.location.coordinates
        ? calculateDistance(startLocation, a.customer.location.coordinates)
        : Infinity;
      const distB = b.customer.location.coordinates
        ? calculateDistance(startLocation, b.customer.location.coordinates)
        : Infinity;
      return distA - distB;
    });

    const totalDistance = sortedJobs.reduce((sum, job, index) => {
      if (index === 0) return sum;
      const prevJob = sortedJobs[index - 1];
      if (!job.customer.location.coordinates || !prevJob.customer.location.coordinates) return sum;

      return sum + calculateDistance(
        prevJob.customer.location.coordinates,
        job.customer.location.coordinates
      );
    }, 0);

    const estimatedProfit = sortedJobs.reduce((sum, job) => {
      return sum + (job.estimate?.totalEstimate?.min || 0);
    }, 0);

    return {
      jobs: sortedJobs,
      totalDistance,
      totalTravelTime: totalDistance / 60 * 60, // Assume 60km/h
      estimatedProfit,
      route: sortedJobs
        .map(job => job.customer.location.coordinates)
        .filter(coord => coord !== undefined) as Coordinates[]
    };
  }

  async findStackableJobs(baseJobId: string): Promise<JobSheet[]> {
    const allJobs = await getAllJobSheets();
    const baseJob = allJobs.find(job => job.jobId === baseJobId);

    if (!baseJob || !baseJob.customer.location.coordinates) {
      return [];
    }

    // Find jobs within 10km of the base job
    const nearbyJobs = await this.findJobsNear(baseJob.customer.location.coordinates, 10);

    // Filter out the base job itself and only include jobs that could be done same day
    return nearbyJobs.filter(job =>
      job.jobId !== baseJobId &&
      job.status === 'new' &&
      job.estimate?.estimatedHours?.max &&
      job.estimate.estimatedHours.max <= 4 // Can be completed in half day
    );
  }

  // Time/availability queries
  async getQuickJobs(maxHours: number, location?: Coordinates): Promise<JobSheet[]> {
    const allJobs = await getAllJobSheets();
    let filteredJobs = allJobs.filter(job =>
      job.status === 'new' &&
      job.estimate?.estimatedHours?.max &&
      job.estimate.estimatedHours.max <= maxHours
    );

    // If location specified, prioritize nearby jobs
    if (location) {
      filteredJobs = filteredJobs.sort((a, b) => {
        const distA = a.customer.location.coordinates
          ? calculateDistance(location, a.customer.location.coordinates)
          : Infinity;
        const distB = b.customer.location.coordinates
          ? calculateDistance(location, b.customer.location.coordinates)
          : Infinity;
        return distA - distB;
      });
    }

    return filteredJobs;
  }

  async getJobsForTimeSlot(date: string, durationHours: number): Promise<JobSheet[]> {
    const availableJobs = await this.getQuickJobs(durationHours);

    // Filter by urgency for the given date
    return availableJobs.filter(job => {
      const urgency = job.job.urgency;

      // Emergency and urgent jobs can be scheduled any time
      if (urgency === 'emergency' || urgency === 'urgent') return true;

      // Other jobs depend on their timing requirements
      const daysSinceCreated = Math.floor(
        (new Date().getTime() - new Date(job.createdAt).getTime()) / (1000 * 60 * 60 * 24)
      );

      if (urgency === 'next_week' && daysSinceCreated >= 7) return true;
      if (urgency === 'next_2_weeks' && daysSinceCreated >= 14) return true;

      return urgency === 'flexible' || urgency === 'when_convenient';
    });
  }

  // Business intelligence
  async getHighProfitJobs(minScore: number): Promise<JobSheet[]> {
    const allJobs = await getAllJobSheets();

    return allJobs.filter(job => {
      if (!job.routing?.profitabilityScore) return false;
      return job.routing.profitabilityScore >= minScore;
    });
  }

  async getUrgentJobs(): Promise<JobSheet[]> {
    const allJobs = await getAllJobSheets();

    return allJobs.filter(job =>
      job.job.urgency === 'emergency' || job.job.urgency === 'urgent'
    ).sort((a, b) => {
      // Emergency first, then by creation date
      if (a.job.urgency === 'emergency' && b.job.urgency !== 'emergency') return -1;
      if (b.job.urgency === 'emergency' && a.job.urgency !== 'emergency') return 1;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
  }

  async getPendingDecisions(): Promise<JobSheet[]> {
    const allJobs = await getAllJobSheets();

    return allJobs.filter(job =>
      job.status === 'new' && !job.reviewed
    ).sort((a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }

  // Scheduling support
  async findOptimalSchedule(availableHours: number, preferences: SchedulingPreferences): Promise<ScheduleSuggestion> {
    const suitableJobs = await this.getQuickJobs(availableHours);

    // Apply preferences
    let filteredJobs = suitableJobs;

    if (preferences.maxTravelTime) {
      filteredJobs = filteredJobs.filter(job =>
        !job.customer.location.travelTime ||
        job.customer.location.travelTime <= preferences.maxTravelTime!
      );
    }

    if (preferences.minimumProfitScore) {
      filteredJobs = filteredJobs.filter(job =>
        job.routing?.profitabilityScore &&
        job.routing.profitabilityScore >= preferences.minimumProfitScore!
      );
    }

    // Select best combination of jobs that fit within available hours
    const selectedJobs: JobSheet[] = [];
    let totalHours = 0;
    let totalProfit = 0;

    // Sort by profitability score and select best combination
    filteredJobs.sort((a, b) =>
      (b.routing?.profitabilityScore || 0) - (a.routing?.profitabilityScore || 0)
    );

    for (const job of filteredJobs) {
      const jobHours = job.estimate?.estimatedHours?.max || 0;
      if (totalHours + jobHours <= availableHours) {
        selectedJobs.push(job);
        totalHours += jobHours;
        totalProfit += job.estimate?.totalEstimate?.min || 0;
      }
    }

    return {
      timeSlot: new Date().toISOString(),
      jobs: selectedJobs,
      totalHours,
      estimatedProfit: totalProfit,
      efficiency: totalHours > 0 ? totalProfit / totalHours : 0
    };
  }

  async checkDependencies(jobId: string): Promise<DependencyStatus> {
    const allJobs = await getAllJobSheets();
    const job = allJobs.find(j => j.jobId === jobId);

    if (!job) {
      return {
        ready: false,
        blockers: ['Job not found'],
        requirements: {
          materials: [],
          weather: false,
          permits: [],
          otherJobs: []
        }
      };
    }

    const blockers: string[] = [];
    const requirements = {
      materials: job.job.materials.customerSupplying || [],
      weather: job.job.location === 'outdoor',
      permits: [] as string[],
      otherJobs: [] as string[]
    };

    // Check if customer is supplying materials
    if (requirements.materials.length > 0) {
      blockers.push('Waiting for customer to supply materials');
    }

    // Check weather dependency
    if (requirements.weather) {
      // In real implementation, check weather forecast
      blockers.push('Weather dependent - check forecast');
    }

    // Check if inspection is needed
    if (job.estimate?.needsInspection) {
      blockers.push('Site inspection required before work can begin');
    }

    return {
      ready: blockers.length === 0,
      blockers,
      requirements
    };
  }
}

// Helper function to calculate distance between two coordinates
function calculateDistance(coord1: Coordinates, coord2: Coordinates): number {
  const R = 6371; // Earth's radius in kilometers
  const dLat = toRadians(coord2.lat - coord1.lat);
  const dLon = toRadians(coord2.lng - coord1.lng);

  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(coord1.lat)) * Math.cos(toRadians(coord2.lat)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // Distance in kilometers
}

function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

// Export singleton instance
export const jobQueryService = new JobQueryService();