export interface JobSheet {
  // Core identification
  jobId: string;
  reference?: string; // Human-readable "JOB-2024-001"

  // Lifecycle management
  status: 'new' | 'reviewing' | 'quoted' | 'accepted' | 'rejected' |
          'scheduled' | 'in_progress' | 'completed' | 'cancelled';
  substatus?: 'waiting_materials' | 'weather_dependent' | 'permit_pending' |
             'customer_approval' | 'ready_to_start';

  // Timestamps
  createdAt: string;
  reviewedAt?: string;
  quotedAt?: string;
  scheduledAt?: string;
  completedAt?: string;

  // Legacy field for backward compatibility
  reviewed?: boolean;

  // Customer information
  customer: {
    name: string;
    phone: string;
    email: string;
    address?: string; // Full address if provided
    location: {
      suburb: string;
      postcode?: string;
      state?: string;
      distanceFromBase?: number; // km
      coordinates?: {lat: number; lng: number};
      travelTime?: number; // minutes
    }
  };

  // Job specifications
  job: {
    title: string;
    description: string;
    category: 'carpentry' | 'plumbing' | 'electrical' | 'painting' | 'general' |
              'fencing' | 'tiling' | 'roofing' | 'doors_windows' | 'gardening';
    subcategory?: string; // "deck_repair", "door_replacement", etc.

    urgency: 'emergency' | 'urgent' | 'next_week' | 'next_2_weeks' |
             'flexible' | 'when_convenient' | 'unspecified';
    location: 'indoor' | 'outdoor' | 'both' | 'customer_site';

    materials: {
      surface?: string; // "timber", "brick", "metal", etc.
      condition?: string; // "rotten", "damaged", "old", etc.
      measurements?: string;
      access?: 'ground_level' | 'ladder_required' | 'scaffolding_required' |
               'difficult_access' | string;
      customerSupplying?: string[];
      type?: string; // Legacy field
    };

    context: {
      historyNotes?: string;
      customerAttempts?: string;
      accessNotes?: string;
      equipmentNeeded?: string[];
      skillLevel?: 'basic_handyman' | 'skilled_handyman' | 'specialist_required';
      problemHistory?: string; // Legacy field
      additionalInfo?: string; // Legacy field
    }
  };

  // Cost estimation
  estimate?: {
    tier: 'basic_handyman' | 'skilled_handyman' | 'specialist' | 'subcontract';
    hourlyRate?: number;
    estimatedHours?: {min: number; max: number};
    estimatedCost?: {min: number; max: number};
    materialsEstimate?: number;
    totalEstimate?: {min: number; max: number};
    confidence: 'low' | 'medium' | 'high';
    notes?: string;
    needsInspection?: boolean;
  };

  // Visual documentation
  photos: Array<{
    url: string;
    type: 'wide_shot' | 'closeup' | 'context' | 'damage_detail';
    caption?: string;
    timestamp?: string;
  }>;

  // Routing & optimization
  routing?: {
    worthTaking?: boolean;
    reasoning?: string;
    profitabilityScore?: number; // 1-10
    difficultyScore?: number; // 1-10
    urgencyScore?: number; // 1-10

    suggestedTradie?: string; // If should be referred
    routeOptimization?: {
      nearbyJobs?: string[]; // Job IDs within reasonable distance
      stackingPotential?: 'none' | 'low' | 'medium' | 'high';
      bestTimeSlots?: string[]; // When to schedule for efficiency
    };
  };

  // Decision tracking (enhanced Todd's decision)
  toddDecision?: {
    decision: 'will_quote' | 'needs_inspection' | 'declined' | 'referred';
    reasoning?: string;
    notes?: string;
    quotedAmount?: number;
    decisionDate: string;
  };

  // Legacy decision fields for backward compatibility
  toddNotes?: string;
  decision?: 'will_quote' | 'declined' | 'needs_inspection' | 'referred';
  decisionDate?: string;
  quotedAmount?: number;

  // AI metadata
  aiAnalysis?: {
    extractionConfidence?: number; // 0-1
    locationConfidence?: number;
    costEstimateConfidence?: number;
    flaggedForReview?: string; // Reason if AI thinks human review needed
    suggestedActions?: string[];
    triageAssessment?: {
      storyLevel: 'simple_repair' | 'standard_job' | 'complex_project';
      quoteConfidence: 'can_quote' | 'needs_inspection' | 'unclear';
      profitPotential: 'high' | 'medium' | 'low';
      complexity: 'straightforward' | 'moderate' | 'difficult';
      accessDifficulty: 'easy' | 'moderate' | 'difficult';
      priorityScore: number; // 1-10, higher = more attractive to take
      recommendation: string;
      triageNotes: string;
    };
  };

  // Original conversation
  conversationData?: {
    messages?: ChatMessage[];
    summary?: string; // AI-generated summary
  };

  // Full conversation for reference (legacy)
  conversationText?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  photos?: Array<{
    file: File;
    preview: string;
  }>;
}

// AI Query Interface Types
export interface Coordinates {
  lat: number;
  lng: number;
}

export interface RouteOptimization {
  jobs: JobSheet[];
  totalDistance: number;
  totalTravelTime: number;
  estimatedProfit: number;
  route: Coordinates[];
}

export interface SchedulingPreferences {
  maxTravelTime?: number;
  preferredHours?: {start: number; end: number};
  avoidWeather?: boolean;
  minimumProfitScore?: number;
}

export interface ScheduleSuggestion {
  timeSlot: string;
  jobs: JobSheet[];
  totalHours: number;
  estimatedProfit: number;
  efficiency: number; // profit per hour including travel
}

export interface DependencyStatus {
  ready: boolean;
  blockers: string[];
  requirements: {
    materials: string[];
    weather: boolean;
    permits: string[];
    otherJobs: string[];
  };
}

// Job Query Interface for AI agents
export interface JobQueryAPI {
  // Location-based queries
  findJobsNear(location: Coordinates, radiusKm: number): Promise<JobSheet[]>;
  getJobsBySuburb(suburb: string): Promise<JobSheet[]>;
  getJobsWithinTravelTime(minutes: number): Promise<JobSheet[]>;

  // Route optimization
  optimizeRoute(startLocation: Coordinates, maxTravelTime: number): Promise<RouteOptimization>;
  findStackableJobs(baseJobId: string): Promise<JobSheet[]>;

  // Time/availability queries
  getQuickJobs(maxHours: number, location?: Coordinates): Promise<JobSheet[]>;
  getJobsForTimeSlot(date: string, durationHours: number): Promise<JobSheet[]>;

  // Business intelligence
  getHighProfitJobs(minScore: number): Promise<JobSheet[]>;
  getUrgentJobs(): Promise<JobSheet[]>;
  getPendingDecisions(): Promise<JobSheet[]>;

  // Scheduling support
  findOptimalSchedule(availableHours: number, preferences: SchedulingPreferences): Promise<ScheduleSuggestion>;
  checkDependencies(jobId: string): Promise<DependencyStatus>;
}

// Job Category mappings for better categorization
export const JOB_CATEGORIES = {
  'door': { category: 'doors_windows', subcategory: 'door_replacement' },
  'window': { category: 'doors_windows', subcategory: 'window_repair' },
  'deck': { category: 'carpentry', subcategory: 'deck_repair' },
  'fence': { category: 'fencing', subcategory: 'fence_repair' },
  'paint': { category: 'painting', subcategory: 'interior_painting' },
  'shelf': { category: 'carpentry', subcategory: 'shelving' },
  'tap': { category: 'plumbing', subcategory: 'tap_repair' },
  'tile': { category: 'tiling', subcategory: 'tile_repair' },
  'roof': { category: 'roofing', subcategory: 'roof_repair' }
} as const;

// Equipment requirements mapping
export const EQUIPMENT_REQUIREMENTS = {
  'door_replacement': ['drill', 'screwdriver', 'chisel', 'level'],
  'deck_repair': ['saw', 'drill', 'hammer', 'level', 'measuring_tape'],
  'fence_repair': ['drill', 'hammer', 'level', 'post_hole_digger'],
  'painting': ['brushes', 'rollers', 'drop_sheets', 'ladder'],
  'plumbing': ['pipe_wrench', 'plunger', 'pipe_cutter'],
  'tiling': ['tile_cutter', 'trowel', 'spacers', 'level']
} as const;