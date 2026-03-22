'use client';

import React, { useState, useEffect } from 'react';
import {
  LogOut,
  Mail,
  Phone,
  MapPin,
  Clock,
  DollarSign,
  Filter,
  Search,
  Calendar,
  User,
  Settings,
  Eye,
  X,
  ChevronDown,
  ChevronUp,
  MessageSquare
} from 'lucide-react';
import { JobSheet } from '@/types/job';
import {
  getAllJobSheets,
  updateJobDecision,
  searchJobs,
  markJobAsReviewed
} from '@/lib/jobService';

interface AdminDashboardProps {
  user: any;
}

const StatusBadge = ({ status, reviewed }: { status: JobSheet['status']; reviewed: boolean }) => {
  const colors: Record<JobSheet['status'], string> = {
    new: reviewed ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800',
    reviewing: 'bg-yellow-100 text-yellow-800',
    quoted: 'bg-green-100 text-green-800',
    accepted: 'bg-green-100 text-green-800',
    rejected: 'bg-gray-100 text-gray-800',
    scheduled: 'bg-blue-100 text-blue-800',
    in_progress: 'bg-purple-100 text-purple-800',
    completed: 'bg-blue-100 text-blue-800',
    cancelled: 'bg-gray-100 text-gray-800',
  };

  const displayStatus = status === 'new' && !reviewed ? 'Needs Review' :
                        status === 'new' && reviewed ? 'Reviewed' :
                        status.charAt(0).toUpperCase() + status.slice(1);

  return (
    <span className={`px-2 py-1 rounded-full text-xs font-medium ${colors[status]}`}>
      {displayStatus}
    </span>
  );
};

const UrgencyBadge = ({ urgency }: { urgency: string }) => {
  const colors = {
    urgent: 'bg-red-100 text-red-800',
    soon: 'bg-orange-100 text-orange-800',
    flexible: 'bg-gray-100 text-gray-800',
    unspecified: 'bg-gray-100 text-gray-600',
  };

  return (
    <span className={`px-2 py-1 rounded-full text-xs font-medium ${colors[urgency as keyof typeof colors]}`}>
      {urgency.charAt(0).toUpperCase() + urgency.slice(1)}
    </span>
  );
};

export default function AdminDashboard({ user }: AdminDashboardProps) {
  const [jobs, setJobs] = useState<JobSheet[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedJob, setSelectedJob] = useState<JobSheet | null>(null);
  const [statusFilter, setStatusFilter] = useState<JobSheet['status'] | 'all'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [showConversation, setShowConversation] = useState(false);

  // Handle escape key to close modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedJob) {
        setSelectedJob(null);
        setShowConversation(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedJob]);

  // Reset conversation state when modal closes
  useEffect(() => {
    if (!selectedJob) {
      setShowConversation(false);
    }
  }, [selectedJob]);

  // Load jobs
  useEffect(() => {
    loadJobs();
  }, []);

  const loadJobs = async () => {
    try {
      setLoading(true);
      const jobsData = await getAllJobSheets();
      setJobs(jobsData);
    } catch (error) {
      console.error('Error loading jobs:', error);
    } finally {
      setLoading(false);
    }
  };

  // Filter jobs
  const filteredJobs = jobs.filter((job) => {
    const matchesStatus = statusFilter === 'all' || job.status === statusFilter;
    const matchesSearch = searchTerm === '' ||
      job.customer.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      job.customer.location.suburb.toLowerCase().includes(searchTerm.toLowerCase()) ||
      job.job.description.toLowerCase().includes(searchTerm.toLowerCase());

    return matchesStatus && matchesSearch;
  });

  // Update job decision
  const handleDecisionUpdate = async (
    firestoreId: string,
    decision: JobSheet['decision'],
    status?: JobSheet['status']
  ) => {
    try {
      await updateJobDecision(
        firestoreId,
        status || 'reviewing',
        decision
      );

      setJobs(prev => prev.map(job =>
        (job as any).firestoreId === firestoreId
          ? { ...job, status: status || 'reviewing', decision, reviewed: true }
          : job
      ));
    } catch (error) {
      console.error('Error updating job decision:', error);
    }
  };

  // Mark job as reviewed
  const handleMarkReviewed = async (firestoreId: string) => {
    try {
      await markJobAsReviewed(firestoreId);
      setJobs(prev => prev.map(job =>
        (job as any).firestoreId === firestoreId
          ? { ...job, reviewed: true }
          : job
      ));
    } catch (error) {
      console.error('Error marking job as reviewed:', error);
    }
  };

  // Sign out
  const handleSignOut = async () => {
    try {
      await fetch('/api/v2/auth/admin/logout', { method: 'POST' });
      window.location.href = '/admin/login';
    } catch (error) {
      console.error('Error signing out:', error);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Odd Job Todd - Admin Dashboard</h1>
              <p className="text-sm text-gray-600">Welcome back, {user?.email}</p>
            </div>
            <button
              onClick={handleSignOut}
              className="flex items-center space-x-2 text-gray-600 hover:text-gray-900"
            >
              <LogOut className="w-4 h-4" />
              <span>Sign Out</span>
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-6">
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center">
              <div className="p-2 bg-red-100 rounded-lg">
                <User className="w-6 h-6 text-red-600" />
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-600">Needs Review</p>
                <p className="text-2xl font-bold text-gray-900">
                  {jobs.filter(j => j.status === 'new' && !j.reviewed).length}
                </p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center">
              <div className="p-2 bg-yellow-100 rounded-lg">
                <Eye className="w-6 h-6 text-yellow-600" />
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-600">Reviewed</p>
                <p className="text-2xl font-bold text-gray-900">
                  {jobs.filter(j => j.reviewed).length}
                </p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center">
              <div className="p-2 bg-green-100 rounded-lg">
                <DollarSign className="w-6 h-6 text-green-600" />
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-600">Will Quote</p>
                <p className="text-2xl font-bold text-gray-900">
                  {jobs.filter(j => j.decision === 'will_quote').length}
                </p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center">
              <div className="p-2 bg-gray-100 rounded-lg">
                <X className="w-6 h-6 text-gray-600" />
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-600">Declined</p>
                <p className="text-2xl font-bold text-gray-900">
                  {jobs.filter(j => j.decision === 'declined').length}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="bg-white rounded-lg shadow p-4 mb-6">
          <div className="flex flex-col sm:flex-row space-y-4 sm:space-y-0 sm:space-x-4">
            <div className="flex-1">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
                <input
                  type="text"
                  placeholder="Search by name, suburb, or description..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10 pr-4 py-2 w-full border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                />
              </div>
            </div>

            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as JobSheet['status'] | 'all')}
              className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
            >
              <option value="all">All Jobs</option>
              <option value="new">Needs Review</option>
              <option value="reviewed">Reviewed</option>
              <option value="declined">Declined</option>
              <option value="quoted">Quoted</option>
              <option value="completed">Completed</option>
            </select>
          </div>
        </div>

        {/* Jobs List */}
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-lg font-medium text-gray-900">
              Job Queue ({filteredJobs.length} jobs)
            </h2>
          </div>

          {loading ? (
            <div className="p-8 text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-orange-500 mx-auto"></div>
              <p className="mt-4 text-gray-600">Loading jobs...</p>
            </div>
          ) : filteredJobs.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              No jobs found matching your filters.
            </div>
          ) : (
            <div className="divide-y divide-gray-200">
              {filteredJobs.map((job) => (
                <div key={job.jobId} className="p-6 hover:bg-gray-50">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center space-x-2 mb-2">
                        <h3 className="text-lg font-medium text-gray-900">
                          {job.job.title}
                        </h3>
                        <StatusBadge status={job.status} reviewed={job.reviewed || false} />
                        <UrgencyBadge urgency={job.job.urgency} />
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                        <div className="flex items-center space-x-2">
                          <User className="w-4 h-4 text-gray-400" />
                          <span className="text-sm text-gray-600">{job.customer.name}</span>
                        </div>
                        <div className="flex items-center space-x-2">
                          <MapPin className="w-4 h-4 text-gray-400" />
                          <span className="text-sm text-gray-600">{job.customer.location.suburb}</span>
                        </div>
                      </div>

                      <p className="text-sm text-gray-600 mb-3 line-clamp-2">
                        {job.job.description || 'Job details available in conversation'}
                      </p>

                      {/* Key job details */}
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-3 text-xs text-gray-500">
                        {job.job.materials?.type && (
                          <span className="bg-blue-50 text-blue-700 px-2 py-1 rounded">
                            {job.job.materials.type}
                          </span>
                        )}
                        {job.job.category !== 'general' && (
                          <span className="bg-purple-50 text-purple-700 px-2 py-1 rounded capitalize">
                            {job.job.category}
                          </span>
                        )}
                        {job.photos.length > 0 && (
                          <span className="bg-green-50 text-green-700 px-2 py-1 rounded">
                            {job.photos.length} photo{job.photos.length !== 1 ? 's' : ''}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center space-x-4 text-sm">
                        <a
                          href={`mailto:${job.customer.email}?subject=Re: Your job enquiry&body=Hi ${job.customer.name},%0D%0A%0D%0ARegarding your enquiry about: ${job.job.title}%0D%0A%0D%0A`}
                          className="flex items-center space-x-1 text-blue-600 hover:text-blue-800"
                        >
                          <Mail className="w-4 h-4" />
                          <span>Email</span>
                        </a>
                        <a
                          href={`tel:${job.customer.phone}`}
                          className="flex items-center space-x-1 text-green-600 hover:text-green-800"
                        >
                          <Phone className="w-4 h-4" />
                          <span>Call</span>
                        </a>
                        <button
                          onClick={() => setSelectedJob(job)}
                          className="flex items-center space-x-1 text-gray-600 hover:text-gray-800"
                        >
                          <Eye className="w-4 h-4" />
                          <span>Details</span>
                        </button>
                      </div>
                    </div>

                    {!job.reviewed ? (
                      <div className="ml-4 flex flex-col space-y-2">
                        <button
                          onClick={() => handleDecisionUpdate((job as any).firestoreId, 'will_quote')}
                          className="px-3 py-1 bg-green-600 text-white text-sm rounded hover:bg-green-700"
                        >
                          Will Quote
                        </button>
                        <button
                          onClick={() => handleDecisionUpdate((job as any).firestoreId, 'needs_inspection')}
                          className="px-3 py-1 bg-yellow-600 text-white text-sm rounded hover:bg-yellow-700"
                        >
                          Need to Inspect
                        </button>
                        <button
                          onClick={() => handleDecisionUpdate((job as any).firestoreId, 'declined')}
                          className="px-3 py-1 bg-gray-600 text-white text-sm rounded hover:bg-gray-700"
                        >
                          Decline
                        </button>
                      </div>
                    ) : (
                      <div className="ml-4 text-sm text-gray-500">
                        {job.decision && (
                          <span className="capitalize">{job.decision.replace('_', ' ')}</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Job Detail Modal */}
      {selectedJob && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSelectedJob(null);
          }}
        >
          <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
            {/* Fixed Header */}
            <div className="flex-shrink-0 px-6 py-4 border-b border-gray-200">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-bold">Job Details - {selectedJob.customer.name}</h2>
                <button
                  onClick={() => setSelectedJob(null)}
                  className="text-gray-500 hover:text-gray-700 p-1"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto p-6">
              <div className="space-y-6">
                {/* Customer Info */}
                <div>
                  <h3 className="font-semibold mb-2">Customer Information</h3>
                  <div className="bg-gray-50 p-4 rounded-lg">
                    <p><strong>Name:</strong> {selectedJob.customer.name}</p>
                    <p><strong>Email:</strong> {selectedJob.customer.email}</p>
                    <p><strong>Phone:</strong> {selectedJob.customer.phone}</p>
                    <p><strong>Location:</strong> {selectedJob.customer.location.suburb}</p>
                  </div>
                </div>

                {/* Job Summary */}
                <div>
                  <h3 className="font-semibold mb-2">Job Summary</h3>
                  <div className="bg-gray-50 p-4 rounded-lg space-y-2">
                    <p><strong>Job Type:</strong> {selectedJob.job.title}</p>
                    <p><strong>Description:</strong> {selectedJob.job.description}</p>
                    <div className="grid grid-cols-2 gap-4 mt-3">
                      <p><strong>Category:</strong> <span className="capitalize">{selectedJob.job.category}</span></p>
                      <p><strong>Urgency:</strong> <UrgencyBadge urgency={selectedJob.job.urgency} /></p>
                    </div>
                  </div>
                </div>

                {/* Technical Details */}
                {(selectedJob.job.materials?.surface || selectedJob.job.materials?.access || selectedJob.job.context?.problemHistory || selectedJob.job.context?.equipmentNeeded) && (
                  <div>
                    <h3 className="font-semibold mb-2">Technical Details</h3>
                    <div className="bg-gray-50 p-4 rounded-lg space-y-2">
                      {selectedJob.job.materials?.surface && (
                        <p><strong>Surface/Material:</strong> {selectedJob.job.materials.surface}</p>
                      )}
                      {selectedJob.job.materials?.condition && (
                        <p><strong>Condition:</strong> {selectedJob.job.materials.condition}</p>
                      )}
                      {selectedJob.job.materials?.measurements && (
                        <p><strong>Measurements:</strong> {selectedJob.job.materials.measurements}</p>
                      )}
                      {selectedJob.job.materials?.access && (
                        <p><strong>Access:</strong> <span className="capitalize">{selectedJob.job.materials.access.replace('_', ' ')}</span></p>
                      )}
                      {selectedJob.job.materials?.customerSupplying && selectedJob.job.materials.customerSupplying.length > 0 && (
                        <p><strong>Customer Supplying:</strong> {selectedJob.job.materials.customerSupplying.join(', ')}</p>
                      )}
                      {selectedJob.job.context?.equipmentNeeded && selectedJob.job.context.equipmentNeeded.length > 0 && (
                        <p><strong>Equipment Needed:</strong> {selectedJob.job.context.equipmentNeeded.join(', ')}</p>
                      )}
                      {selectedJob.job.context?.skillLevel && (
                        <p><strong>Skill Level:</strong> <span className="capitalize">{selectedJob.job.context.skillLevel.replace('_', ' ')}</span></p>
                      )}
                      {selectedJob.job.context?.problemHistory && (
                        <p><strong>Issue Details:</strong> {selectedJob.job.context.problemHistory}</p>
                      )}
                      {selectedJob.job.context?.accessNotes && (
                        <p><strong>Access Notes:</strong> {selectedJob.job.context.accessNotes}</p>
                      )}
                    </div>
                  </div>
                )}

                {/* Cost Estimate */}
                {selectedJob.estimate && (
                  <div>
                    <h3 className="font-semibold mb-2">Cost Estimate</h3>
                    <div className="bg-blue-50 p-4 rounded-lg space-y-2">
                      <div className="grid grid-cols-2 gap-4">
                        <p><strong>Tier:</strong> <span className="capitalize">{selectedJob.estimate.tier?.replace('_', ' ')}</span></p>
                        <p><strong>Confidence:</strong>
                          <span className={`ml-2 px-2 py-1 rounded text-xs ${
                            selectedJob.estimate.confidence === 'high' ? 'bg-green-100 text-green-800' :
                            selectedJob.estimate.confidence === 'medium' ? 'bg-yellow-100 text-yellow-800' :
                            'bg-red-100 text-red-800'
                          }`}>
                            {selectedJob.estimate.confidence}
                          </span>
                        </p>
                      </div>
                      {selectedJob.estimate.hourlyRate && (
                        <p><strong>Hourly Rate:</strong> ${selectedJob.estimate.hourlyRate}</p>
                      )}
                      {selectedJob.estimate.estimatedHours && (
                        <p><strong>Estimated Hours:</strong> {selectedJob.estimate.estimatedHours.min}-{selectedJob.estimate.estimatedHours.max} hours</p>
                      )}
                      {selectedJob.estimate.materialsEstimate && (
                        <p><strong>Materials:</strong> ${selectedJob.estimate.materialsEstimate}</p>
                      )}
                      {selectedJob.estimate.totalEstimate && (
                        <p><strong>Total Estimate:</strong> ${selectedJob.estimate.totalEstimate.min}-${selectedJob.estimate.totalEstimate.max}</p>
                      )}
                      {selectedJob.estimate.needsInspection && (
                        <p className="text-orange-700"><strong>⚠️ Inspection Required</strong></p>
                      )}
                      {selectedJob.estimate.notes && (
                        <p className="text-sm text-gray-600 mt-2"><strong>Notes:</strong> {selectedJob.estimate.notes}</p>
                      )}
                    </div>
                  </div>
                )}

                {/* Routing Intelligence */}
                {selectedJob.routing && (
                  <div>
                    <h3 className="font-semibold mb-2">Business Intelligence</h3>
                    <div className="bg-purple-50 p-4 rounded-lg space-y-2">
                      <div className="flex items-center space-x-4">
                        <p><strong>Worth Taking:</strong>
                          <span className={`ml-2 px-2 py-1 rounded text-xs ${
                            selectedJob.routing.worthTaking ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                          }`}>
                            {selectedJob.routing.worthTaking ? 'Yes' : 'No'}
                          </span>
                        </p>
                        {selectedJob.routing.profitabilityScore && (
                          <p><strong>Profit Score:</strong> {selectedJob.routing.profitabilityScore}/10</p>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        {selectedJob.routing.difficultyScore && (
                          <p><strong>Difficulty:</strong> {selectedJob.routing.difficultyScore}/10</p>
                        )}
                        {selectedJob.routing.urgencyScore && (
                          <p><strong>Urgency:</strong> {selectedJob.routing.urgencyScore}/10</p>
                        )}
                      </div>
                      {selectedJob.routing.reasoning && (
                        <p className="text-sm text-gray-600"><strong>Analysis:</strong> {selectedJob.routing.reasoning}</p>
                      )}
                      {selectedJob.routing.routeOptimization?.stackingPotential && (
                        <p><strong>Stacking Potential:</strong> <span className="capitalize">{selectedJob.routing.routeOptimization.stackingPotential}</span></p>
                      )}
                    </div>
                  </div>
                )}

                {/* Location Details */}
                {(selectedJob.customer.location.distanceFromBase || selectedJob.customer.location.coordinates) && (
                  <div>
                    <h3 className="font-semibold mb-2">Location Intelligence</h3>
                    <div className="bg-green-50 p-4 rounded-lg space-y-2">
                      {selectedJob.customer.location.distanceFromBase && (
                        <p><strong>Distance from Base:</strong> {selectedJob.customer.location.distanceFromBase}km</p>
                      )}
                      {selectedJob.customer.location.travelTime && (
                        <p><strong>Travel Time:</strong> {selectedJob.customer.location.travelTime} minutes</p>
                      )}
                      {selectedJob.customer.location.coordinates && (
                        <p className="text-sm text-gray-600">
                          <strong>Coordinates:</strong> {selectedJob.customer.location.coordinates.lat.toFixed(4)}, {selectedJob.customer.location.coordinates.lng.toFixed(4)}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {/* Todd's Review */}
                {selectedJob.reviewed && (
                  <div>
                    <h3 className="font-semibold mb-2">Todd's Review</h3>
                    <div className="bg-gray-50 p-4 rounded-lg">
                      {selectedJob.decision && (
                        <p><strong>Decision:</strong> <span className="capitalize">{selectedJob.decision.replace('_', ' ')}</span></p>
                      )}
                      {selectedJob.toddNotes && (
                        <p><strong>Notes:</strong> {selectedJob.toddNotes}</p>
                      )}
                      {selectedJob.decisionDate && (
                        <p><strong>Reviewed:</strong> {new Date(selectedJob.decisionDate).toLocaleDateString()}</p>
                      )}
                    </div>
                  </div>
                )}

                {/* Photos */}
                {selectedJob.photos.length > 0 && (
                  <div>
                    <h3 className="font-semibold mb-2">Photos ({selectedJob.photos.length})</h3>
                    <div className="grid grid-cols-2 gap-4">
                      {selectedJob.photos.map((photo, index) => (
                        <div key={index}>
                          <img
                            src={photo.url}
                            alt={photo.caption || 'Job photo'}
                            className="w-full h-32 object-cover rounded"
                          />
                          {photo.caption && (
                            <p className="text-sm text-gray-600 mt-1">{photo.caption}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Full Conversation */}
                {selectedJob.conversationText && (
                  <div>
                    <button
                      onClick={() => setShowConversation(!showConversation)}
                      className="flex items-center space-x-2 text-gray-600 hover:text-gray-800 mb-3"
                    >
                      <MessageSquare className="w-4 h-4" />
                      <span className="font-semibold">Full Conversation</span>
                      {showConversation ? (
                        <ChevronUp className="w-4 h-4" />
                      ) : (
                        <ChevronDown className="w-4 h-4" />
                      )}
                    </button>

                    {showConversation && (
                      <div className="bg-gray-50 p-4 rounded-lg max-h-60 overflow-y-auto">
                        <pre className="whitespace-pre-wrap text-sm text-gray-700 font-mono">
                          {selectedJob.conversationText}
                        </pre>
                      </div>
                    )}
                  </div>
                )}

                {/* Action Buttons */}
                {!selectedJob.reviewed && (
                  <div className="border-t pt-6">
                    <h3 className="font-semibold mb-4">Make Decision</h3>
                    <div className="flex space-x-3">
                      <button
                        onClick={() => {
                          handleDecisionUpdate((selectedJob as any).firestoreId, 'will_quote');
                          setSelectedJob(null);
                        }}
                        className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
                      >
                        Will Quote
                      </button>
                      <button
                        onClick={() => {
                          handleDecisionUpdate((selectedJob as any).firestoreId, 'needs_inspection');
                          setSelectedJob(null);
                        }}
                        className="px-4 py-2 bg-yellow-600 text-white rounded hover:bg-yellow-700"
                      >
                        Need to Inspect
                      </button>
                      <button
                        onClick={() => {
                          handleDecisionUpdate((selectedJob as any).firestoreId, 'declined');
                          setSelectedJob(null);
                        }}
                        className="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700"
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}