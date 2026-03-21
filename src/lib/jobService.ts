import {
  collection,
  doc,
  addDoc,
  updateDoc,
  getDocs,
  getDoc,
  query,
  orderBy,
  where,
  Timestamp,
  deleteDoc
} from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { getFirebaseDb, getFirebaseStorage } from './firebase';
import { JobSheet } from '@/types/job';
import { v4 as uuidv4 } from 'uuid';

// Lazy jobs collection reference
function getJobsCollection() {
  return collection(getFirebaseDb(), 'jobs');
}

// Create a new job sheet with enhanced location intelligence
export async function createJobSheet(jobData: Omit<JobSheet, 'jobId' | 'createdAt'>): Promise<string> {
  const jobId = uuidv4();

  // Enhance job with geocoding and routing intelligence
  const enhancedJobData = await enhanceJobWithLocationIntelligence(jobData);

  const jobSheet: JobSheet = {
    ...enhancedJobData,
    jobId,
    createdAt: new Date().toISOString(),
  };

  const docRef = await addDoc(getJobsCollection(), jobSheet);
  return docRef.id;
}

// Get all job sheets
export async function getAllJobSheets(): Promise<JobSheet[]> {
  const q = query(getJobsCollection(), orderBy('createdAt', 'desc'));
  const querySnapshot = await getDocs(q);

  return querySnapshot.docs.map(doc => ({
    ...(doc.data() as JobSheet),
    firestoreId: doc.id,
  })) as (JobSheet & { firestoreId: string })[];
}

// Get jobs by status
export async function getJobsByStatus(status: JobSheet['status']): Promise<JobSheet[]> {
  const q = query(
    getJobsCollection(),
    where('status', '==', status),
    orderBy('createdAt', 'desc')
  );
  const querySnapshot = await getDocs(q);

  return querySnapshot.docs.map(doc => ({
    ...(doc.data() as JobSheet),
    firestoreId: doc.id,
  })) as (JobSheet & { firestoreId: string })[];
}

// Update job status and decision
export async function updateJobDecision(
  firestoreId: string,
  status: JobSheet['status'],
  decision?: JobSheet['decision'],
  notes?: string,
  quotedAmount?: number
): Promise<void> {
  const docRef = doc(getJobsCollection(), firestoreId);
  const updateData: any = {
    status,
    reviewed: true,
    decisionDate: new Date().toISOString(),
  };

  if (decision) updateData.decision = decision;
  if (notes) updateData.toddNotes = notes;
  if (quotedAmount) updateData.quotedAmount = quotedAmount;

  await updateDoc(docRef, updateData);
}

// Upload photo to Firebase Storage
export async function uploadPhoto(file: File, jobId: string): Promise<string> {
  const fileName = `jobs/${jobId}/${uuidv4()}-${file.name}`;
  const storageRef = ref(getFirebaseStorage(), fileName);

  const snapshot = await uploadBytes(storageRef, file);
  const downloadURL = await getDownloadURL(snapshot.ref);

  return downloadURL;
}

// Upload multiple photos
export async function uploadPhotos(files: File[], jobId: string): Promise<string[]> {
  const uploadPromises = files.map(file => uploadPhoto(file, jobId));
  return Promise.all(uploadPromises);
}

// Mark job as reviewed
export async function markJobAsReviewed(
  firestoreId: string,
  decision?: JobSheet['decision'],
  notes?: string
): Promise<void> {
  const docRef = doc(getJobsCollection(), firestoreId);
  await updateDoc(docRef, {
    reviewed: true,
    decision,
    toddNotes: notes,
    decisionDate: new Date().toISOString(),
  });
}

// Delete job sheet
export async function deleteJobSheet(firestoreId: string): Promise<void> {
  const docRef = doc(getJobsCollection(), firestoreId);
  await deleteDoc(docRef);
}

// Search jobs by suburb or description
export async function searchJobs(searchTerm: string): Promise<JobSheet[]> {
  // Note: Firestore doesn't support full-text search well
  // For production, you'd want to use Algolia or similar
  // This is a basic implementation
  const allJobs = await getAllJobSheets();

  const searchLower = searchTerm.toLowerCase();
  return allJobs.filter(job =>
    job.customer.location.suburb.toLowerCase().includes(searchLower) ||
    job.job.description.toLowerCase().includes(searchLower) ||
    job.customer.name.toLowerCase().includes(searchLower)
  );
}

// Enhance job with location intelligence and routing scores
async function enhanceJobWithLocationIntelligence(jobData: Omit<JobSheet, 'jobId' | 'createdAt'>): Promise<Omit<JobSheet, 'jobId' | 'createdAt'>> {
  try {
    // Call geocoding service
    const geocodeResponse = await fetch('/api/geocode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: jobData.customer.address,
        suburb: jobData.customer.location.suburb,
        postcode: jobData.customer.location.postcode
      })
    });

    if (geocodeResponse.ok) {
      const geocodeData = await geocodeResponse.json();

      // Update customer location with geocoded data
      const enhancedJobData = {
        ...jobData,
        customer: {
          ...jobData.customer,
          location: {
            ...jobData.customer.location,
            coordinates: geocodeData.coordinates,
            distanceFromBase: geocodeData.distanceFromBase,
            travelTime: geocodeData.travelTime,
            state: geocodeData.state || jobData.customer.location.state,
            postcode: geocodeData.postcode || jobData.customer.location.postcode
          }
        }
      };

      // Add routing intelligence
      const routingData = calculateRoutingIntelligence(enhancedJobData);
      enhancedJobData.routing = routingData;

      return enhancedJobData;
    }
  } catch (error) {
    console.error('Failed to enhance job with location intelligence:', error);
  }

  // Return original data if geocoding fails
  return jobData;
}

// Calculate routing intelligence scores
function calculateRoutingIntelligence(jobData: Omit<JobSheet, 'jobId' | 'createdAt'>): JobSheet['routing'] {
  const distanceFromBase = jobData.customer.location.distanceFromBase || 50; // Default 50km
  const estimatedProfit = jobData.estimate?.totalEstimate?.min || 0;
  const estimatedHours = jobData.estimate?.estimatedHours?.max || 1;

  // Calculate profitability score (1-10)
  const profitPerHour = estimatedHours > 0 ? estimatedProfit / estimatedHours : 0;
  const profitabilityScore = Math.min(10, Math.max(1, Math.round(profitPerHour / 150 * 10))); // $150/hr = score 10

  // Calculate difficulty score (1-10, higher = more difficult)
  let difficultyScore = 1;
  if (jobData.job.materials.access === 'scaffolding_required') difficultyScore += 3;
  if (jobData.job.materials.access === 'ladder_required') difficultyScore += 1;
  if (jobData.job.context.skillLevel === 'specialist_required') difficultyScore += 3;
  if (jobData.job.context.skillLevel === 'skilled_handyman') difficultyScore += 1;
  if (jobData.estimate?.needsInspection) difficultyScore += 2;

  // Calculate urgency score (1-10)
  const urgencyScores = {
    emergency: 10,
    urgent: 8,
    next_week: 6,
    next_2_weeks: 4,
    flexible: 2,
    when_convenient: 1,
    unspecified: 3
  };
  const urgencyScore = urgencyScores[jobData.job.urgency] || 3;

  // Determine if job is worth taking
  const distanceScore = Math.max(1, 11 - Math.min(10, distanceFromBase / 5)); // Closer = better
  const overallScore = (profitabilityScore * 0.4) + (distanceScore * 0.3) + (urgencyScore * 0.2) + ((11 - difficultyScore) * 0.1);
  const worthTaking = overallScore > 6;

  // Generate reasoning
  const reasons = [];
  if (profitabilityScore >= 7) reasons.push('Good profit margin');
  if (profitabilityScore < 4) reasons.push('Low profit margin');
  if (distanceFromBase <= 10) reasons.push('Close to base');
  if (distanceFromBase > 30) reasons.push('Far from base');
  if (urgencyScore >= 8) reasons.push('Urgent job');
  if (difficultyScore <= 3) reasons.push('Simple job');
  if (difficultyScore >= 7) reasons.push('Complex job');

  const reasoning = reasons.join(', ') || 'Standard job characteristics';

  return {
    worthTaking,
    reasoning,
    profitabilityScore,
    difficultyScore,
    urgencyScore,
    routeOptimization: {
      nearbyJobs: [], // Will be populated when other jobs are found nearby
      stackingPotential: estimatedHours <= 4 ? 'high' : 'low',
      bestTimeSlots: generateOptimalTimeSlots(jobData.job.urgency, jobData.job.location)
    }
  };
}

// Generate optimal time slots based on job characteristics
function generateOptimalTimeSlots(urgency: JobSheet['job']['urgency'], location: JobSheet['job']['location']): string[] {
  const slots: string[] = [];

  if (urgency === 'emergency') {
    slots.push('ASAP', 'Today', 'Tomorrow');
  } else if (urgency === 'urgent') {
    slots.push('This week', 'Next available', 'Morning slot');
  } else if (location === 'outdoor') {
    slots.push('Morning (better weather)', 'Dry day', 'Weekend');
  } else {
    slots.push('Standard booking', 'Flexible timing', 'When convenient');
  }

  return slots;
}