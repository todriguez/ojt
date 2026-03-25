"use client";

import React, { useState, useEffect, useCallback } from "react";

// ── Types ───────────────────────────────────

interface Lead {
  id: string;
  jobType: string | null;
  subcategory: string | null;
  scopeSummary: string | null;
  status: string;
  urgency: string | null;
  effortBand: string | null;
  recommendation: string | null;
  recommendationReason: string | null;
  customerFitScore: number | null;
  customerFitLabel: string | null;
  quoteWorthinessScore: number | null;
  quoteWorthinessLabel: string | null;
  confidenceScore: number | null;
  confidenceLabel: string | null;
  estimateAckStatus: string | null;
  suburb: string | null;
  suburbGroup: string | null;
  romRange: { min: number; max: number } | null;
  customerName: string | null;
  customerPhone: string | null;
  isRepeatCustomer: boolean;
  repeatJobCount: number;
  scheduleContext: null;
  needsReview: boolean;
  hasOutcome: boolean;
  humanDecision: string | null;
  updatedAt: string;
  createdAt: string;
}

// ── Badge Components ────────────────────────

const REC_COLORS: Record<string, string> = {
  priority_lead: "bg-green-100 text-green-800 border-green-300",
  worth_quoting: "bg-blue-100 text-blue-800 border-blue-300",
  probably_bookable: "bg-teal-100 text-teal-800 border-teal-300",
  needs_site_visit: "bg-orange-100 text-orange-800 border-orange-300",
  only_if_nearby: "bg-gray-100 text-gray-600 border-gray-300",
  not_price_aligned: "bg-red-100 text-red-700 border-red-300",
  not_a_fit: "bg-red-200 text-red-900 border-red-400",
  ignore: "bg-gray-50 text-gray-400 border-gray-200",
};

function RecommendationBadge({ value }: { value: string | null }) {
  if (!value) return <span className="text-xs text-gray-400">No score</span>;
  const label = value.replace(/_/g, " ").toUpperCase();
  return (
    <span className={`inline-block px-2 py-0.5 text-xs font-semibold rounded border ${REC_COLORS[value] || "bg-gray-100 text-gray-600"}`}>
      {label}
    </span>
  );
}

function FitDots({ score }: { score: number | null }) {
  if (score === null) return <span className="text-xs text-gray-400">—</span>;
  const filled = score <= 20 ? 1 : score <= 40 ? 2 : score <= 60 ? 3 : score <= 80 ? 4 : 5;
  return (
    <span className="text-sm" title={`Fit: ${score}`}>
      {"●".repeat(filled)}{"○".repeat(5 - filled)}
      <span className="ml-1 text-xs text-gray-500">{score}</span>
    </span>
  );
}

function ConfidenceBadge({ label, score }: { label: string | null; score: number | null }) {
  if (!label) return null;
  const colors: Record<string, string> = {
    high: "text-green-700 bg-green-50",
    medium: "text-amber-700 bg-amber-50",
    low: "text-red-700 bg-red-50",
  };
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded ${colors[label] || ""}`} title={`Confidence: ${score}`}>
      {label.charAt(0).toUpperCase() + label.slice(1)}
    </span>
  );
}

function EstimateAckBadge({ status }: { status: string | null }) {
  if (!status) return null;
  const icons: Record<string, string> = {
    accepted: "✓", tentative: "~", pushback: "⚠", rejected: "✗",
    wants_exact_price: "💲", rate_shopping: "🔍", pending: "⋯",
  };
  return <span className="text-xs" title={`Estimate: ${status}`}>{icons[status] || status}</span>;
}

// ── Effort Band Display ─────────────────────

const EFFORT_LABELS: Record<string, string> = {
  quick: "Quick", short: "Short", quarter_day: "¼ day",
  half_day: "½ day", full_day: "Full day", multi_day: "Multi-day", unknown: "?",
};

// ── Lead Card ───────────────────────────────

function LeadCard({
  lead,
  onAction,
  actionLoading,
}: {
  lead: Lead;
  onAction: (id: string, action: string) => void;
  actionLoading: string | null;
}) {
  const isLoading = actionLoading === lead.id;

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-3">
      {/* Row 1: Badges */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <RecommendationBadge value={lead.recommendation} />
        <FitDots score={lead.customerFitScore} />
        <span className="text-xs text-gray-500">W:{lead.quoteWorthinessScore ?? "—"}</span>
        <ConfidenceBadge label={lead.confidenceLabel} score={lead.confidenceScore} />
        {lead.isRepeatCustomer && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-purple-50 text-purple-700">
            🔁 {lead.repeatJobCount} jobs
          </span>
        )}
        {lead.needsReview && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-800 font-medium">
            Needs Review
          </span>
        )}
      </div>

      {/* Row 2: Job description */}
      <div className="mb-2">
        <span className="font-medium text-gray-900 text-sm">
          {lead.jobType ? `${lead.jobType.replace(/_/g, " ")}` : "Unknown"}
          {lead.subcategory ? ` — ${lead.subcategory}` : ""}
        </span>
        {lead.scopeSummary && (
          <p className="text-xs text-gray-600 mt-0.5 line-clamp-2">{lead.scopeSummary}</p>
        )}
      </div>

      {/* Row 3: Location / effort / urgency / estimate */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500 mb-2">
        {lead.suburb && <span>📍 {lead.suburb}</span>}
        {lead.effortBand && <span>⏱ {EFFORT_LABELS[lead.effortBand] || lead.effortBand}</span>}
        {lead.urgency && lead.urgency !== "unspecified" && (
          <span>🕐 {lead.urgency.replace(/_/g, " ")}</span>
        )}
        {lead.romRange && (
          <span>
            💰 ${lead.romRange.min}–${lead.romRange.max}
            {" "}
            <EstimateAckBadge status={lead.estimateAckStatus} />
          </span>
        )}
        {lead.customerName && <span>👤 {lead.customerName}</span>}
      </div>

      {/* Row 4: Schedule context (placeholder) */}
      <div className="flex gap-x-3 text-xs text-gray-300 mb-3">
        <span>📅 Week: —</span>
        <span>📍 Near: —</span>
        <span>☀ Weather: —</span>
      </div>

      {/* Row 5: Actions */}
      <div className="flex flex-wrap gap-2">
        {["followed_up", "evaluated", "committed", "inspected", "declined"].map((action) => (
          <button
            key={action}
            onClick={() => onAction(lead.id, action)}
            disabled={isLoading}
            className={`px-3 py-1.5 text-xs font-medium rounded border transition-colors ${
              action === "declined"
                ? "border-red-200 text-red-600 hover:bg-red-50"
                : "border-gray-200 text-gray-700 hover:bg-gray-50"
            } ${isLoading ? "opacity-50 cursor-not-allowed" : ""}`}
          >
            {action === "followed_up" ? "Follow Up" :
             action === "evaluated" ? "Quote" :
             action === "committed" ? "Book" :
             action === "inspected" ? "Site Visit" :
             "Decline"}
          </button>
        ))}
      </div>

      {/* Row 6: System vs Todd (if outcome exists) */}
      {lead.hasOutcome && (
        <div className="mt-2 pt-2 border-t border-gray-100 text-xs text-gray-500">
          System: {lead.recommendation?.replace(/_/g, " ") || "—"}
          {" · "}
          Todd: {lead.humanDecision?.replace(/_/g, " ") || "—"}
        </div>
      )}
    </div>
  );
}

// ── Filter Panel ────────────────────────────

const RECOMMENDATION_OPTIONS = [
  "priority_lead", "worth_quoting", "probably_bookable",
  "needs_site_visit", "only_if_nearby", "not_price_aligned", "not_a_fit", "ignore",
];

const EFFORT_OPTIONS = ["quick", "short", "quarter_day", "half_day", "full_day", "multi_day"];
const SUBURB_GROUP_OPTIONS = ["core", "extended", "outside", "unknown"];

function FilterPanel({
  filters,
  onFilterChange,
}: {
  filters: Record<string, string[]>;
  onFilterChange: (key: string, values: string[]) => void;
}) {
  const [open, setOpen] = useState(false);

  const toggleFilter = (key: string, value: string) => {
    const current = filters[key] || [];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    onFilterChange(key, next);
  };

  return (
    <div className="mb-4">
      <button
        onClick={() => setOpen(!open)}
        className="text-sm text-blue-600 hover:text-blue-800 font-medium"
      >
        {open ? "▼ Hide Filters" : "▶ Show Filters"}
        {Object.values(filters).some(v => v.length > 0) && " (active)"}
      </button>

      {open && (
        <div className="mt-3 p-4 bg-gray-50 rounded-lg border border-gray-200 space-y-3">
          <FilterGroup
            label="Recommendation"
            options={RECOMMENDATION_OPTIONS}
            selected={filters.recommendation || []}
            onToggle={(v) => toggleFilter("recommendation", v)}
          />
          <FilterGroup
            label="Effort Band"
            options={EFFORT_OPTIONS}
            selected={filters.effortBand || []}
            onToggle={(v) => toggleFilter("effortBand", v)}
          />
          <FilterGroup
            label="Suburb Group"
            options={SUBURB_GROUP_OPTIONS}
            selected={filters.suburbGroup || []}
            onToggle={(v) => toggleFilter("suburbGroup", v)}
          />
          <div className="flex gap-4">
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={(filters.needsReview || []).includes("true")}
                onChange={() => toggleFilter("needsReview", "true")}
                className="rounded"
              />
              Needs Review
            </label>
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={(filters.disagreement || []).includes("true")}
                onChange={() => toggleFilter("disagreement", "true")}
                className="rounded"
              />
              System ≠ Todd
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

function FilterGroup({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <div>
      <div className="text-xs font-medium text-gray-700 mb-1">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => (
          <button
            key={opt}
            onClick={() => onToggle(opt)}
            className={`px-2 py-0.5 text-xs rounded border transition-colors ${
              selected.includes(opt)
                ? "bg-blue-100 border-blue-300 text-blue-800"
                : "bg-white border-gray-200 text-gray-600 hover:bg-gray-50"
            }`}
          >
            {opt.replace(/_/g, " ")}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Main Page ───────────────────────────────

export default function LeadQueuePage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [sort, setSort] = useState("updated_at");
  const [filters, setFilters] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("sort", sort);
      params.set("order", "desc");
      params.set("limit", "50");

      // Apply filters
      for (const [key, values] of Object.entries(filters)) {
        if (values.length > 0) {
          if (key === "needsReview" || key === "disagreement") {
            params.set(key, "true");
          } else {
            params.set(key, values.join(","));
          }
        }
      }

      const res = await fetch(`/api/v2/admin/leads?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setLeads(data.leads);
      setTotal(data.total);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [sort, filters]);

  useEffect(() => {
    fetchLeads();
  }, [fetchLeads]);

  const handleAction = async (jobId: string, action: string) => {
    setActionLoading(jobId);
    try {
      const res = await fetch(`/api/v2/admin/leads/${jobId}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Refresh the list
      await fetchLeads();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setActionLoading(null);
    }
  };

  const handleFilterChange = (key: string, values: string[]) => {
    setFilters((prev) => ({ ...prev, [key]: values }));
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Lead Queue</h1>
            <p className="text-sm text-gray-500">
              {total} lead{total !== 1 ? "s" : ""}
              {Object.values(filters).some(v => v.length > 0) && " (filtered)"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="text-sm border border-gray-200 rounded px-2 py-1"
            >
              <option value="updated_at">Recent</option>
              <option value="worthiness">Worthiness</option>
              <option value="fit">Customer Fit</option>
              <option value="confidence">Confidence</option>
              <option value="created_at">Newest</option>
            </select>
            <button
              onClick={fetchLeads}
              className="text-sm text-blue-600 hover:text-blue-800"
            >
              ↻
            </button>
          </div>
        </div>

        {/* Filters */}
        <FilterPanel filters={filters} onFilterChange={handleFilterChange} />

        {/* Error */}
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="text-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto"></div>
            <p className="mt-3 text-sm text-gray-500">Loading leads...</p>
          </div>
        )}

        {/* Empty state */}
        {!loading && leads.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            <p className="text-lg">No leads yet</p>
            <p className="text-sm mt-1">Leads will appear here once conversations start flowing.</p>
          </div>
        )}

        {/* Lead cards */}
        {!loading && leads.map((lead) => (
          <LeadCard
            key={lead.id}
            lead={lead}
            onAction={handleAction}
            actionLoading={actionLoading}
          />
        ))}
      </div>
    </div>
  );
}
