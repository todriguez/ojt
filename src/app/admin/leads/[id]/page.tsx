"use client";

import React, { useState, useEffect, use } from "react";

// ── Types ───────────────────────────────────

interface ScoringSection {
  score: number;
  label: string;
  reasoning?: string[];
  positiveSignals?: string[];
  negativeSignals?: string[];
  factors?: string[];
  value?: string;
  reason?: string;
  actionHint?: string;
}

interface LeadDetail {
  job: any;
  scoring: {
    fit: ScoringSection;
    worthiness: ScoringSection;
    recommendation: { value: string; reason: string; actionHint: string };
    confidence: { score: number; label: string; factors: string[] };
    completeness: {
      total: number;
      scopeClarity: number;
      locationClarity: number;
      contactReadiness: number;
      estimateReadiness: number;
      decisionReadiness: number;
    };
    estimateAck: { status: string | null; presented: boolean; acknowledged: boolean };
  };
  conversation: Array<{
    id: string;
    senderType: string;
    content: string;
    extraction: any;
    timestamp: string;
  }>;
  metadata: any;
  outcome: any;
}

// ── Sub Score Bar ───────────────────────────

function ScoreBar({ label, value, max = 100 }: { label: string; value: number; max?: number }) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const color = pct >= 70 ? "bg-green-400" : pct >= 40 ? "bg-amber-400" : "bg-red-400";
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-32 text-gray-600">{label}</span>
      <div className="flex-1 bg-gray-100 rounded-full h-2">
        <div className={`${color} rounded-full h-2`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-right text-gray-500">{value}</span>
    </div>
  );
}

// ── Expandable Section ──────────────────────

function Expandable({ title, children, defaultOpen = false }: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-gray-200 rounded-lg mb-3 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-4 py-3 text-left text-sm font-medium text-gray-700 bg-gray-50 hover:bg-gray-100 flex justify-between"
      >
        {title}
        <span>{open ? "▼" : "▶"}</span>
      </button>
      {open && <div className="px-4 py-3">{children}</div>}
    </div>
  );
}

// ── Main Page ───────────────────────────────

export default function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<LeadDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rescoring, setRescoring] = useState(false);
  const [rescoreResult, setRescoreResult] = useState<any>(null);
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    fetch(`/api/v2/admin/leads/${id}`)
      .then((r) => r.json())
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  const handleRescore = async () => {
    setRescoring(true);
    try {
      const res = await fetch(`/api/v2/admin/leads/${id}/rescore`, { method: "POST" });
      const result = await res.json();
      setRescoreResult(result);
      // Refresh data
      const refresh = await fetch(`/api/v2/admin/leads/${id}`);
      setData(await refresh.json());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRescoring(false);
    }
  };

  const handleAction = async (action: string) => {
    setActionLoading(true);
    try {
      await fetch(`/api/v2/admin/leads/${id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const refresh = await fetch(`/api/v2/admin/leads/${id}`);
      setData(await refresh.json());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-gray-50 p-6">
        <div className="max-w-2xl mx-auto p-4 bg-red-50 border border-red-200 rounded text-red-700">
          {error || "Lead not found"}
        </div>
      </div>
    );
  }

  const { job, scoring, conversation, metadata, outcome } = data;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto px-4 py-6">
        {/* Back link */}
        <a href="/admin/leads" className="text-sm text-blue-600 hover:text-blue-800 mb-4 inline-block">
          ← Back to Queue
        </a>

        {/* Header */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-4">
          <div className="flex items-center justify-between mb-2">
            <h1 className="text-lg font-bold text-gray-900">
              {metadata?.jobType?.replace(/_/g, " ") || "Unknown Job"}
              {metadata?.suburb ? ` — ${metadata.suburb}` : ""}
            </h1>
            <span className={`px-2 py-0.5 text-xs font-semibold rounded border ${
              scoring.recommendation.value === "priority_lead" ? "bg-green-100 text-green-800 border-green-300" :
              scoring.recommendation.value === "worth_quoting" ? "bg-blue-100 text-blue-800 border-blue-300" :
              "bg-gray-100 text-gray-600 border-gray-300"
            }`}>
              {scoring.recommendation.value?.replace(/_/g, " ").toUpperCase()}
            </span>
          </div>
          <p className="text-sm text-gray-600">{scoring.recommendation.reason}</p>
          <p className="text-xs text-gray-400 mt-1">{scoring.recommendation.actionHint}</p>
        </div>

        {/* Section A: Scoring Summary */}
        <Expandable title="Scoring Summary" defaultOpen>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div className="text-center p-3 bg-gray-50 rounded">
              <div className="text-2xl font-bold">{scoring.fit.score}</div>
              <div className="text-xs text-gray-500">Fit: {scoring.fit.label?.replace(/_/g, " ")}</div>
            </div>
            <div className="text-center p-3 bg-gray-50 rounded">
              <div className="text-2xl font-bold">{scoring.worthiness.score}</div>
              <div className="text-xs text-gray-500">Worth: {scoring.worthiness.label?.replace(/_/g, " ")}</div>
            </div>
            <div className="text-center p-3 bg-gray-50 rounded">
              <div className="text-2xl font-bold">{scoring.confidence.score}</div>
              <div className="text-xs text-gray-500">Confidence: {scoring.confidence.label}</div>
            </div>
            <div className="text-center p-3 bg-gray-50 rounded">
              <div className="text-2xl font-bold">{scoring.completeness.total}</div>
              <div className="text-xs text-gray-500">Completeness</div>
            </div>
          </div>

          <div className="space-y-2 mb-4">
            <ScoreBar label="Scope Clarity" value={scoring.completeness.scopeClarity} />
            <ScoreBar label="Location Clarity" value={scoring.completeness.locationClarity} />
            <ScoreBar label="Contact Readiness" value={scoring.completeness.contactReadiness} />
            <ScoreBar label="Estimate Readiness" value={scoring.completeness.estimateReadiness} />
            <ScoreBar label="Decision Readiness" value={scoring.completeness.decisionReadiness} />
          </div>

          {/* Reasoning */}
          {scoring.fit.reasoning && scoring.fit.reasoning.length > 0 && (
            <div className="mb-3">
              <div className="text-xs font-medium text-gray-700 mb-1">Fit reasoning:</div>
              <div className="text-xs text-gray-500 space-y-0.5">
                {scoring.fit.reasoning.map((r: string, i: number) => <div key={i}>{r}</div>)}
              </div>
            </div>
          )}

          {/* Re-score button */}
          <button
            onClick={handleRescore}
            disabled={rescoring}
            className="text-sm px-3 py-1.5 border border-blue-200 text-blue-600 rounded hover:bg-blue-50 disabled:opacity-50"
          >
            {rescoring ? "Re-scoring..." : "Re-score"}
          </button>
          {rescoreResult && (
            <div className="mt-2 text-xs p-2 bg-gray-50 rounded">
              {rescoreResult.changed ? (
                <div>
                  <span className="text-amber-600 font-medium">Changed: </span>
                  Fit {rescoreResult.before.fit}→{rescoreResult.after.fit},
                  Worth {rescoreResult.before.worthiness}→{rescoreResult.after.worthiness},
                  Rec {rescoreResult.before.recommendation}→{rescoreResult.after.recommendation}
                </div>
              ) : (
                <span className="text-green-600">No change — scoring is current.</span>
              )}
            </div>
          )}
        </Expandable>

        {/* Section B: Conversation */}
        <Expandable title={`Conversation (${conversation.length} messages)`}>
          {conversation.length === 0 ? (
            <p className="text-sm text-gray-400">No messages recorded.</p>
          ) : (
            <div className="space-y-3">
              {conversation.map((msg) => (
                <div
                  key={msg.id}
                  className={`p-3 rounded-lg text-sm ${
                    msg.senderType === "customer"
                      ? "bg-gray-100 mr-8"
                      : "bg-blue-50 ml-8"
                  }`}
                >
                  <div className="flex justify-between mb-1">
                    <span className="text-xs font-medium text-gray-600">
                      {msg.senderType === "customer" ? "Customer" : "AI"}
                    </span>
                    <span className="text-xs text-gray-400">
                      {new Date(msg.timestamp).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-gray-800 whitespace-pre-wrap">{msg.content}</p>
                  {msg.extraction && (
                    <details className="mt-2">
                      <summary className="text-xs text-blue-500 cursor-pointer">Extracted data</summary>
                      <pre className="mt-1 text-xs text-gray-500 overflow-x-auto">
                        {JSON.stringify(msg.extraction, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              ))}
            </div>
          )}
        </Expandable>

        {/* Section C: Metadata */}
        <Expandable title="Job Metadata">
          <pre className="text-xs text-gray-600 overflow-x-auto whitespace-pre-wrap">
            {JSON.stringify(metadata, null, 2)}
          </pre>
        </Expandable>

        {/* Section D: Schedule Context (placeholder) */}
        <Expandable title="Schedule Context">
          <div className="grid grid-cols-2 gap-3 text-sm text-gray-400">
            <div>📍 Distance: —</div>
            <div>🚗 Travel: —</div>
            <div>📅 Day load: —</div>
            <div>📅 Week load: —</div>
            <div>🌤 Weather: —</div>
            <div>🔧 Materials: —</div>
          </div>
          <p className="text-xs text-gray-300 mt-2">
            Context will populate once calendar/weather integrations are connected.
          </p>
        </Expandable>

        {/* Section E: Outcome / Actions */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-4">
          <h3 className="text-sm font-medium text-gray-700 mb-3">Actions</h3>

          <div className="flex flex-wrap gap-2 mb-4">
            {["followed_up", "quoted", "booked", "site_visited", "declined", "archived"].map((action) => (
              <button
                key={action}
                onClick={() => handleAction(action)}
                disabled={actionLoading}
                className={`px-3 py-1.5 text-xs font-medium rounded border transition-colors ${
                  action === "declined" || action === "archived"
                    ? "border-red-200 text-red-600 hover:bg-red-50"
                    : "border-gray-200 text-gray-700 hover:bg-gray-50"
                } ${actionLoading ? "opacity-50" : ""}`}
              >
                {action.replace(/_/g, " ").replace(/^\w/, c => c.toUpperCase())}
              </button>
            ))}
          </div>

          {/* Outcome display */}
          {outcome && (
            <div className="p-3 bg-gray-50 rounded border border-gray-100">
              <div className="text-xs text-gray-600 space-y-1">
                <div>Decision: <strong>{outcome.humanDecision?.replace(/_/g, " ")}</strong></div>
                {outcome.systemRecommendation && (
                  <div>System said: {outcome.systemRecommendation.replace(/_/g, " ")}</div>
                )}
                {outcome.actualOutcome && (
                  <div>Outcome: {outcome.actualOutcome.replace(/_/g, " ")}</div>
                )}
                {outcome.wasSystemCorrect !== null && (
                  <div>System correct: {outcome.wasSystemCorrect ? "Yes ✓" : "No ✗"}</div>
                )}
                {outcome.missType && outcome.missType !== "none" && (
                  <div>Miss type: {outcome.missType.replace(/_/g, " ")}</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
