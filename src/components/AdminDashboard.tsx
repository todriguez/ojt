'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  LogOut,
  Phone,
  MapPin,
  Clock,
  DollarSign,
  Search,
  User,
  Eye,
  X,
  ChevronDown,
  ChevronUp,
  MessageSquare,
  Star,
  TrendingUp,
  AlertTriangle,
  CheckCircle,
  XCircle,
  RefreshCw,
  Zap,
} from 'lucide-react';

// ── Types matching /api/v2/admin/leads response ──

interface Lead {
  id: string;
  jobType: string | null;
  subcategory: string | null;
  scopeSummary: string | null;
  status: string;
  urgency: string | null;
  effortBand: string | null;
  // Scoring
  recommendation: string | null;
  recommendationReason: string | null;
  customerFitScore: number | null;
  customerFitLabel: string | null;
  quoteWorthinessScore: number | null;
  quoteWorthinessLabel: string | null;
  confidenceScore: number | null;
  confidenceLabel: string | null;
  estimateAckStatus: string | null;
  // Location
  suburb: string | null;
  suburbGroup: string | null;
  // Estimate
  romRange: { min: number; max: number } | null;
  estimatedHours: { min: number; max: number } | null;
  romConfidence: "low" | "medium" | "high" | null;
  labourOnly: boolean | null;
  materialsNote: string | null;
  effortBandReason: string | null;
  // Sub-scores
  scopeClarity: number | null;
  locationClarity: number | null;
  estimateReadiness: number | null;
  contactReadiness: number | null;
  // Customer
  customerName: string | null;
  customerPhone: string | null;
  isRepeatCustomer: boolean | null;
  repeatJobCount: number | null;
  // Review
  needsReview: boolean | null;
  hasOutcome: boolean;
  humanDecision: string | null;
  completenessScore: number | null;
  // Timestamps
  updatedAt: string;
  createdAt: string;
}

interface AdminDashboardProps {
  user: any;
}

// ── Badge Components ──

const RecommendationBadge = ({ rec }: { rec: string | null }) => {
  if (!rec) return null;
  const styles: Record<string, string> = {
    priority_lead: 'bg-green-600 text-white',
    probably_bookable: 'bg-green-100 text-green-800',
    worth_quoting: 'bg-blue-100 text-blue-800',
    needs_site_visit: 'bg-yellow-100 text-yellow-800',
    only_if_nearby: 'bg-orange-100 text-orange-800',
    not_price_aligned: 'bg-red-100 text-red-800',
    not_a_fit: 'bg-gray-200 text-gray-700',
    ignore: 'bg-gray-100 text-gray-500',
  };
  const label = rec.replace(/_/g, ' ');
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wide ${styles[rec] || 'bg-gray-100 text-gray-600'}`}>
      {label}
    </span>
  );
};

const StatusBadge = ({ status }: { status: string }) => {
  const styles: Record<string, string> = {
    new_lead: 'bg-red-100 text-red-800',
    partial_intake: 'bg-yellow-100 text-yellow-800',
    estimate_presented: 'bg-blue-100 text-blue-800',
    estimate_accepted: 'bg-green-100 text-green-800',
    ready_for_review: 'bg-orange-100 text-orange-800',
    needs_site_visit: 'bg-purple-100 text-purple-800',
    scheduled: 'bg-indigo-100 text-indigo-800',
    complete: 'bg-green-200 text-green-900',
    not_a_fit: 'bg-gray-200 text-gray-600',
    archived: 'bg-gray-100 text-gray-500',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${styles[status] || 'bg-gray-100 text-gray-600'}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
};

const UrgencyBadge = ({ urgency }: { urgency: string | null }) => {
  if (!urgency || urgency === 'unspecified') return null;
  const styles: Record<string, string> = {
    emergency: 'bg-red-600 text-white',
    urgent: 'bg-red-100 text-red-800',
    next_week: 'bg-orange-100 text-orange-700',
    next_2_weeks: 'bg-yellow-100 text-yellow-700',
    flexible: 'bg-gray-100 text-gray-600',
    when_convenient: 'bg-gray-100 text-gray-500',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${styles[urgency] || 'bg-gray-100 text-gray-600'}`}>
      {urgency === 'next_2_weeks' ? '2 weeks' : urgency.replace(/_/g, ' ')}
    </span>
  );
};

const ScoreBar = ({ score, label, color }: { score: number | null; label: string; color: string }) => {
  if (score === null || score === undefined) return null;
  const widthPct = Math.min(100, Math.max(0, score));
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500 w-20 shrink-0">{label}</span>
      <div className="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${widthPct}%` }} />
      </div>
      <span className="text-xs font-medium text-gray-700 w-8 text-right">{score}</span>
    </div>
  );
};

const EffortBadge = ({ band }: { band: string | null }) => {
  if (!band || band === 'unknown') return null;
  const icons: Record<string, string> = {
    quick_fix: '15m',
    half_day: '½d',
    full_day: '1d',
    multi_day: '2d+',
  };
  return (
    <span className="px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 text-xs font-medium">
      {icons[band] || band.replace(/_/g, ' ')}
    </span>
  );
};

// ── Main Dashboard ──

export default function AdminDashboard({ user }: AdminDashboardProps) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [recFilter, setRecFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [sortField, setSortField] = useState('updated_at');
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const loadLeads = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      params.set('limit', '50');
      params.set('sort', sortField);
      if (recFilter !== 'all') params.set('recommendation', recFilter);
      if (statusFilter !== 'all') params.set('status', statusFilter);

      const res = await fetch(`/api/v2/admin/leads?${params.toString()}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setLeads(data.leads || []);
      setTotal(data.total || 0);
    } catch (err: any) {
      console.error('Error loading leads:', err);
      setError(err.message || 'Failed to load leads');
    } finally {
      setLoading(false);
    }
  }, [sortField, recFilter, statusFilter]);

  useEffect(() => {
    loadLeads();
  }, [loadLeads]);

  // Client-side search filter
  const filteredLeads = leads.filter((lead) => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return (
      (lead.customerName || '').toLowerCase().includes(term) ||
      (lead.suburb || '').toLowerCase().includes(term) ||
      (lead.scopeSummary || '').toLowerCase().includes(term) ||
      (lead.jobType || '').toLowerCase().includes(term)
    );
  });

  // Quick action handler
  const handleAction = async (jobId: string, action: string) => {
    try {
      setActionLoading(jobId);
      const res = await fetch(`/api/v2/admin/leads/${jobId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error('Action failed');
      // Reload leads
      await loadLeads();
      if (selectedLead?.id === jobId) setSelectedLead(null);
    } catch (err) {
      console.error('Action error:', err);
    } finally {
      setActionLoading(null);
    }
  };

  // Sign out
  const handleSignOut = async () => {
    try {
      await fetch('/api/v2/auth/admin/logout', { method: 'POST' });
      window.location.href = '/admin/login';
    } catch (err) {
      console.error('Sign out error:', err);
    }
  };

  // Stats
  const stats = {
    needsReview: leads.filter(l => !l.hasOutcome && l.status !== 'archived').length,
    priority: leads.filter(l => l.recommendation === 'priority_lead' || l.recommendation === 'probably_bookable').length,
    quoted: leads.filter(l => l.humanDecision === 'evaluated' || l.humanDecision === 'committed').length,
    declined: leads.filter(l => l.humanDecision === 'declined' || l.humanDecision === 'archived').length,
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Odd Job Todd</h1>
              <p className="text-sm text-gray-500">{user?.email}</p>
            </div>
            <div className="flex items-center gap-3">
              <a
                href="/admin/chat"
                className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 text-white text-sm rounded-lg hover:bg-amber-700 transition"
              >
                <MessageSquare className="w-4 h-4" />
                <span className="hidden sm:inline">Copilot</span>
              </a>
              <a
                href="/admin/import-job"
                className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-200 text-gray-600 text-sm rounded-lg hover:bg-gray-50 transition"
              >
                <span className="hidden sm:inline">Import PDF</span>
                <span className="sm:hidden">PDF</span>
              </a>
              <button
                onClick={loadLeads}
                className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
                title="Refresh"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
              <button
                onClick={handleSignOut}
                className="flex items-center gap-2 text-gray-500 hover:text-gray-700 text-sm"
              >
                <LogOut className="w-4 h-4" />
                <span className="hidden sm:inline">Sign Out</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <StatCard icon={<AlertTriangle className="w-5 h-5 text-orange-500" />} label="Needs Review" value={stats.needsReview} />
          <StatCard icon={<Zap className="w-5 h-5 text-green-500" />} label="Priority" value={stats.priority} />
          <StatCard icon={<DollarSign className="w-5 h-5 text-blue-500" />} label="Quoted/Booked" value={stats.quoted} />
          <StatCard icon={<XCircle className="w-5 h-5 text-gray-400" />} label="Declined" value={stats.declined} />
        </div>

        {/* Filters */}
        <div className="bg-white rounded-lg shadow-sm p-4 mb-6 flex flex-col sm:flex-row gap-3">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" />
            <input
              type="text"
              placeholder="Search name, suburb, job type..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10 pr-4 py-2 w-full border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
            />
          </div>
          <select
            value={recFilter}
            onChange={(e) => setRecFilter(e.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm"
          >
            <option value="all">All Recommendations</option>
            <option value="priority_lead">Priority Lead</option>
            <option value="probably_bookable">Probably Bookable</option>
            <option value="worth_quoting">Worth Quoting</option>
            <option value="needs_site_visit">Needs Site Visit</option>
            <option value="only_if_nearby">Only If Nearby</option>
            <option value="not_price_aligned">Not Price Aligned</option>
            <option value="ignore">Ignore</option>
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm"
          >
            <option value="all">All Statuses</option>
            <option value="new_lead">New Lead</option>
            <option value="partial_intake">Partial Intake</option>
            <option value="estimate_presented">Estimate Presented</option>
            <option value="ready_for_review">Ready for Review</option>
            <option value="needs_site_visit">Needs Site Visit</option>
            <option value="scheduled">Scheduled</option>
          </select>
          <select
            value={sortField}
            onChange={(e) => setSortField(e.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm"
          >
            <option value="updated_at">Recent</option>
            <option value="worthiness">Worthiness</option>
            <option value="fit">Customer Fit</option>
            <option value="created_at">Created</option>
          </select>
        </div>

        {/* Error state */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 text-red-700 text-sm">
            {error}
            <button onClick={loadLeads} className="ml-3 underline">Retry</button>
          </div>
        )}

        {/* Lead Cards */}
        <div className="space-y-3">
          <div className="text-sm text-gray-500 px-1">
            {filteredLeads.length} lead{filteredLeads.length !== 1 ? 's' : ''}{total > leads.length ? ` of ${total}` : ''}
          </div>

          {loading && leads.length === 0 ? (
            <div className="bg-white rounded-lg shadow-sm p-12 text-center">
              <RefreshCw className="w-8 h-8 text-gray-300 animate-spin mx-auto mb-3" />
              <p className="text-gray-500">Loading leads...</p>
            </div>
          ) : filteredLeads.length === 0 ? (
            <div className="bg-white rounded-lg shadow-sm p-12 text-center text-gray-500">
              {leads.length === 0 ? 'No leads yet. Start a conversation on the chatbot to create one.' : 'No leads match your filters.'}
            </div>
          ) : (
            filteredLeads.map((lead) => (
              <LeadCard
                key={lead.id}
                lead={lead}
                onSelect={() => setSelectedLead(lead)}
                onAction={(action) => handleAction(lead.id, action)}
                actionLoading={actionLoading === lead.id}
              />
            ))
          )}
        </div>
      </div>

      {/* Lead Detail Modal */}
      {selectedLead && (
        <LeadDetailModal
          lead={selectedLead}
          onClose={() => setSelectedLead(null)}
          onAction={(action) => handleAction(selectedLead.id, action)}
          actionLoading={actionLoading === selectedLead.id}
        />
      )}
    </div>
  );
}

// ── Stat Card ──

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="bg-white rounded-lg shadow-sm p-4 flex items-center gap-3">
      <div className="p-2 rounded-lg bg-gray-50">{icon}</div>
      <div>
        <p className="text-xs text-gray-500">{label}</p>
        <p className="text-xl font-bold text-gray-900">{value}</p>
      </div>
    </div>
  );
}

// ── Lead Card ──

function LeadCard({
  lead,
  onSelect,
  onAction,
  actionLoading,
}: {
  lead: Lead;
  onSelect: () => void;
  onAction: (action: string) => void;
  actionLoading: boolean;
}) {
  const timeAgo = getTimeAgo(lead.createdAt);

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-100 hover:border-gray-200 transition-colors">
      <div className="p-4">
        {/* Top row: badges */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex flex-wrap items-center gap-2">
            <RecommendationBadge rec={lead.recommendation} />
            <StatusBadge status={lead.status} />
            <UrgencyBadge urgency={lead.urgency} />
            <EffortBadge band={lead.effortBand} />
          </div>
          <span className="text-xs text-gray-400 shrink-0 ml-2">{timeAgo}</span>
        </div>

        {/* Main content */}
        <div className="flex items-start gap-4">
          <div className="flex-1 min-w-0">
            {/* Job type + scope */}
            <h3 className="font-medium text-gray-900 truncate">
              {lead.jobType
                ? `${lead.jobType.replace(/_/g, ' ')}${lead.subcategory ? ' — ' + lead.subcategory.replace(/_/g, ' ') : ''}`
                : 'New enquiry'}
            </h3>
            {lead.scopeSummary && (
              <p className="text-sm text-gray-600 mt-1 line-clamp-2">{lead.scopeSummary}</p>
            )}

            {/* Customer + Location row */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-sm text-gray-500">
              {lead.customerName && (
                <span className="flex items-center gap-1">
                  <User className="w-3.5 h-3.5" />
                  {lead.customerName}
                  {lead.isRepeatCustomer && (
                    <Star className="w-3 h-3 text-yellow-500 fill-yellow-500" />
                  )}
                </span>
              )}
              {lead.suburb && (
                <span className="flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5" />
                  {lead.suburb}
                  {lead.suburbGroup && (
                    <span className={`text-xs px-1 rounded ${
                      lead.suburbGroup === 'core' ? 'bg-green-50 text-green-700' :
                      lead.suburbGroup === 'extended' ? 'bg-yellow-50 text-yellow-700' :
                      'bg-red-50 text-red-700'
                    }`}>{lead.suburbGroup}</span>
                  )}
                </span>
              )}
              {lead.customerPhone && (
                <a href={`tel:${lead.customerPhone}`} className="flex items-center gap-1 text-blue-600 hover:text-blue-800">
                  <Phone className="w-3.5 h-3.5" />
                  {lead.customerPhone}
                </a>
              )}
              {lead.romRange && (
                <span className="flex items-center gap-1">
                  <DollarSign className="w-3.5 h-3.5" />
                  ${lead.romRange.min}–${lead.romRange.max}
                  {lead.labourOnly === false && <span className="text-xs text-gray-500">(all-in)</span>}
                  {lead.labourOnly === true && <span className="text-xs text-gray-500">(labour)</span>}
                  {lead.romConfidence && (
                    <span className={`text-xs px-1 rounded ${
                      lead.romConfidence === 'high' ? 'bg-green-50 text-green-700' :
                      lead.romConfidence === 'low' ? 'bg-red-50 text-red-700' :
                      'bg-yellow-50 text-yellow-700'
                    }`}>{lead.romConfidence}</span>
                  )}
                </span>
              )}
              {lead.estimatedHours && (
                <span className="flex items-center gap-1 text-gray-500">
                  <Clock className="w-3.5 h-3.5" />
                  {lead.estimatedHours.min}–{lead.estimatedHours.max} hrs
                </span>
              )}
            </div>

            {/* Score bars */}
            <div className="mt-3 space-y-1">
              <ScoreBar score={lead.quoteWorthinessScore} label="Worthiness" color="bg-blue-500" />
              <ScoreBar score={lead.customerFitScore} label="Cust. Fit" color="bg-green-500" />
            </div>

            {lead.recommendationReason && (
              <p className="text-xs text-gray-400 mt-2 italic">{lead.recommendationReason}</p>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex flex-col gap-1.5 shrink-0">
            <button
              onClick={onSelect}
              className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg hover:bg-gray-50 text-gray-600"
            >
              <Eye className="w-3.5 h-3.5 inline mr-1" />Details
            </button>
            {!lead.hasOutcome && (
              <>
                <button
                  onClick={() => onAction('evaluated')}
                  disabled={actionLoading}
                  className="px-3 py-1.5 text-xs bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
                >
                  <CheckCircle className="w-3.5 h-3.5 inline mr-1" />Quote
                </button>
                <button
                  onClick={() => onAction('inspected')}
                  disabled={actionLoading}
                  className="px-3 py-1.5 text-xs bg-yellow-500 text-white rounded-lg hover:bg-yellow-600 disabled:opacity-50"
                >
                  <Eye className="w-3.5 h-3.5 inline mr-1" />Visit
                </button>
                <button
                  onClick={() => onAction('declined')}
                  disabled={actionLoading}
                  className="px-3 py-1.5 text-xs bg-gray-500 text-white rounded-lg hover:bg-gray-600 disabled:opacity-50"
                >
                  <XCircle className="w-3.5 h-3.5 inline mr-1" />Pass
                </button>
              </>
            )}
            {lead.hasOutcome && lead.humanDecision && (
              <span className="px-3 py-1.5 text-xs text-center rounded-lg bg-gray-100 text-gray-600 capitalize">
                {lead.humanDecision.replace(/_/g, ' ')}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Lead Detail Modal ──

function LeadDetailModal({
  lead,
  onClose,
  onAction,
  actionLoading,
}: {
  lead: Lead;
  onClose: () => void;
  onAction: (action: string) => void;
  actionLoading: boolean;
}) {
  const [showConversation, setShowConversation] = useState(false);
  const [messages, setMessages] = useState<any[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);

  const loadConversation = async () => {
    if (messages.length > 0) {
      setShowConversation(!showConversation);
      return;
    }
    try {
      setLoadingMessages(true);
      const res = await fetch(`/api/v2/chat?jobId=${lead.id}`);
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages || []);
      }
      setShowConversation(true);
    } catch {
      // Chat history may not be available
    } finally {
      setLoadingMessages(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div>
            <h2 className="text-lg font-bold text-gray-900">
              {lead.jobType ? lead.jobType.replace(/_/g, ' ') : 'Job'}{lead.subcategory ? ` — ${lead.subcategory.replace(/_/g, ' ')}` : ''}
            </h2>
            <div className="flex items-center gap-2 mt-1">
              <RecommendationBadge rec={lead.recommendation} />
              <StatusBadge status={lead.status} />
            </div>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Scope */}
          {lead.scopeSummary && (
            <Section title="Scope">
              <p className="text-gray-700">{lead.scopeSummary}</p>
            </Section>
          )}

          {/* Customer */}
          <Section title="Customer">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <Field label="Name" value={lead.customerName} />
              <Field label="Phone" value={lead.customerPhone} isPhone />
              <Field label="Suburb" value={lead.suburb} />
              <Field label="Area" value={lead.suburbGroup} />
              {lead.isRepeatCustomer && (
                <div className="col-span-2 flex items-center gap-1 text-yellow-700">
                  <Star className="w-4 h-4 fill-yellow-500" />
                  Repeat customer ({lead.repeatJobCount} jobs)
                </div>
              )}
            </div>
          </Section>

          {/* Scoring */}
          <Section title="Scoring">
            <div className="space-y-2">
              <ScoreBar score={lead.quoteWorthinessScore} label="Worthiness" color="bg-blue-500" />
              <ScoreBar score={lead.customerFitScore} label="Cust. Fit" color="bg-green-500" />
              <ScoreBar score={lead.completenessScore} label="Completeness" color="bg-purple-500" />
              {lead.confidenceScore !== null && (
                <ScoreBar score={lead.confidenceScore} label="Confidence" color="bg-gray-400" />
              )}
            </div>
            {/* Sub-scores */}
            {(lead.scopeClarity !== null || lead.locationClarity !== null) && (
              <div className="mt-3 pt-3 border-t space-y-1">
                <p className="text-xs font-medium text-gray-500 mb-1">Readiness Breakdown</p>
                <ScoreBar score={lead.scopeClarity} label="Scope Clarity" color="bg-indigo-400" />
                <ScoreBar score={lead.locationClarity} label="Location" color="bg-teal-400" />
                <ScoreBar score={lead.estimateReadiness} label="Estimate Ready" color="bg-amber-400" />
                <ScoreBar score={lead.contactReadiness} label="Contact" color="bg-pink-400" />
              </div>
            )}
            {lead.recommendationReason && (
              <p className="text-sm text-gray-500 mt-3 italic">{lead.recommendationReason}</p>
            )}
          </Section>

          {/* Job Details */}
          <Section title="Details">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <Field label="Urgency" value={lead.urgency?.replace(/_/g, ' ')} />
              <Field label="Effort" value={lead.effortBand?.replace(/_/g, ' ')} />
              <Field label="Estimate Ack" value={lead.estimateAckStatus?.replace(/_/g, ' ')} />
              {lead.romRange && (
                <Field label="ROM" value={`$${lead.romRange.min} – $${lead.romRange.max}${lead.labourOnly === false ? ' (all-in)' : lead.labourOnly === true ? ' (labour)' : ''}`} />
              )}
              {lead.estimatedHours && (
                <Field label="Hours" value={`${lead.estimatedHours.min}–${lead.estimatedHours.max} hrs`} />
              )}
              {lead.romConfidence && (
                <Field label="ROM Confidence" value={lead.romConfidence} />
              )}
            </div>
            {lead.effortBandReason && (
              <p className="text-xs text-gray-400 mt-2">{lead.effortBandReason}</p>
            )}
            {lead.materialsNote && (
              <p className="text-xs text-gray-500 mt-1 italic">{lead.materialsNote}</p>
            )}
          </Section>

          {/* Conversation */}
          <div>
            <button
              onClick={loadConversation}
              className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-800"
            >
              <MessageSquare className="w-4 h-4" />
              <span className="font-medium">Conversation</span>
              {loadingMessages ? (
                <RefreshCw className="w-3 h-3 animate-spin" />
              ) : showConversation ? (
                <ChevronUp className="w-4 h-4" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )}
            </button>
            {showConversation && messages.length > 0 && (
              <div className="mt-3 space-y-2 max-h-60 overflow-y-auto bg-gray-50 rounded-lg p-4">
                {messages.map((msg: any) => (
                  <div key={msg.id} className={`text-sm ${msg.senderType === 'customer' ? 'text-gray-900' : 'text-blue-700'}`}>
                    <span className="font-medium capitalize">{msg.senderType}:</span>{' '}
                    {msg.content}
                  </div>
                ))}
              </div>
            )}
            {showConversation && messages.length === 0 && (
              <p className="mt-2 text-sm text-gray-400">No conversation history available.</p>
            )}
          </div>
        </div>

        {/* Action Footer */}
        {!lead.hasOutcome && (
          <div className="border-t px-6 py-4 flex gap-3">
            <button
              onClick={() => onAction('followed_up')}
              disabled={actionLoading}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              Follow Up
            </button>
            <button
              onClick={() => onAction('evaluated')}
              disabled={actionLoading}
              className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
            >
              Will Quote
            </button>
            <button
              onClick={() => onAction('inspected')}
              disabled={actionLoading}
              className="px-4 py-2 text-sm bg-yellow-500 text-white rounded-lg hover:bg-yellow-600 disabled:opacity-50"
            >
              Site Visit
            </button>
            <button
              onClick={() => onAction('declined')}
              disabled={actionLoading}
              className="px-4 py-2 text-sm bg-gray-500 text-white rounded-lg hover:bg-gray-600 disabled:opacity-50"
            >
              Decline
            </button>
          </div>
        )}
        {lead.hasOutcome && lead.humanDecision && (
          <div className="border-t px-6 py-3 text-sm text-gray-500">
            Decision: <span className="font-medium capitalize">{lead.humanDecision.replace(/_/g, ' ')}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Helpers ──

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">{title}</h3>
      <div className="bg-gray-50 rounded-lg p-4">{children}</div>
    </div>
  );
}

function Field({ label, value, isPhone }: { label: string; value: string | null | undefined; isPhone?: boolean }) {
  if (!value) return <div><span className="text-gray-400 text-xs">{label}</span><br /><span className="text-gray-300">—</span></div>;
  return (
    <div>
      <span className="text-gray-400 text-xs">{label}</span><br />
      {isPhone ? (
        <a href={`tel:${value}`} className="text-blue-600 hover:text-blue-800">{value}</a>
      ) : (
        <span className="text-gray-800 capitalize">{value}</span>
      )}
    </div>
  );
}

function getTimeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}
