'use client';

import { useState } from 'react';
import { Send, Bot, User, AlertCircle, CheckCircle, Clock, DollarSign } from 'lucide-react';

interface QueryResponse {
  data?: any[];
  error?: string;
  suggestions?: string[];
}

export default function AIAssistantPage() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [responses, setResponses] = useState<Array<{
    query: string;
    response: QueryResponse;
    timestamp: string;
  }>>([]);

  const exampleQueries = [
    "Show me urgent jobs",
    "Find jobs near 20km",
    "What jobs can I do in 3 hours?",
    "Jobs in Cooroy",
    "High profit jobs",
    "Jobs pending review"
  ];

  const handleQuery = async () => {
    if (!query.trim()) return;

    setLoading(true);
    const timestamp = new Date().toLocaleTimeString();

    try {
      const response = await fetch(`/api/jobs/query?q=${encodeURIComponent(query)}`);
      const data = await response.json();

      setResponses(prev => [{
        query,
        response: data,
        timestamp
      }, ...prev]);

      setQuery('');
    } catch (error) {
      console.error('Query failed:', error);
      setResponses(prev => [{
        query,
        response: { error: 'Failed to process query' },
        timestamp
      }, ...prev]);
    } finally {
      setLoading(false);
    }
  };

  const formatJobSummary = (job: any) => (
    <div key={job.jobId} className="border rounded-lg p-4 mb-3 bg-white">
      <div className="flex justify-between items-start mb-2">
        <h4 className="font-semibold text-lg">{job.job?.title || 'Job'}</h4>
        <div className="flex space-x-2">
          {job.routing?.worthTaking && (
            <span className="px-2 py-1 bg-green-100 text-green-800 text-xs rounded">
              Worth Taking
            </span>
          )}
          {job.estimate?.confidence && (
            <span className={`px-2 py-1 text-xs rounded ${
              job.estimate.confidence === 'high' ? 'bg-blue-100 text-blue-800' :
              job.estimate.confidence === 'medium' ? 'bg-yellow-100 text-yellow-800' :
              'bg-red-100 text-red-800'
            }`}>
              {job.estimate.confidence} confidence
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
        <div>
          <p><strong>Customer:</strong> {job.customer?.name}</p>
          <p><strong>Location:</strong> {job.customer?.location?.suburb}</p>
          {job.customer?.location?.distanceFromBase && (
            <p><strong>Distance:</strong> {job.customer.location.distanceFromBase}km</p>
          )}
        </div>

        <div>
          <p><strong>Category:</strong> {job.job?.category}</p>
          <p><strong>Urgency:</strong> {job.job?.urgency}</p>
          {job.estimate?.estimatedHours && (
            <p><strong>Est. Hours:</strong> {job.estimate.estimatedHours.min}-{job.estimate.estimatedHours.max}h</p>
          )}
        </div>

        <div>
          {job.estimate?.totalEstimate && (
            <p><strong>Est. Cost:</strong> ${job.estimate.totalEstimate.min}-${job.estimate.totalEstimate.max}</p>
          )}
          {job.routing?.profitabilityScore && (
            <p><strong>Profit Score:</strong> {job.routing.profitabilityScore}/10</p>
          )}
          {job.routing?.difficultyScore && (
            <p><strong>Difficulty:</strong> {job.routing.difficultyScore}/10</p>
          )}
        </div>
      </div>

      {job.job?.description && (
        <p className="text-gray-600 text-sm mt-2 line-clamp-2">{job.job.description}</p>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <div className="flex items-center space-x-3 mb-4">
            <Bot className="w-8 h-8 text-blue-600" />
            <div>
              <h1 className="text-2xl font-bold">AI Business Assistant</h1>
              <p className="text-gray-600">Ask natural language questions about your jobs</p>
            </div>
          </div>

          {/* Query Input */}
          <div className="flex space-x-3">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleQuery()}
              placeholder="Ask about your jobs... (e.g., 'Show me urgent jobs')"
              className="flex-1 px-4 py-3 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
            <button
              onClick={handleQuery}
              disabled={loading || !query.trim()}
              className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center space-x-2"
            >
              {loading ? (
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
              ) : (
                <Send className="w-5 h-5" />
              )}
              <span>Ask</span>
            </button>
          </div>

          {/* Example Queries */}
          <div className="mt-4">
            <p className="text-sm text-gray-600 mb-2">Try these examples:</p>
            <div className="flex flex-wrap gap-2">
              {exampleQueries.map((example, index) => (
                <button
                  key={index}
                  onClick={() => setQuery(example)}
                  className="px-3 py-1 bg-gray-100 hover:bg-gray-200 text-sm rounded-full transition-colors"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Responses */}
        <div className="space-y-6">
          {responses.map((item, index) => (
            <div key={index} className="bg-white rounded-lg shadow overflow-hidden">
              {/* Query */}
              <div className="bg-blue-50 px-6 py-4 border-b">
                <div className="flex items-center space-x-3">
                  <User className="w-5 h-5 text-blue-600" />
                  <span className="font-medium">{item.query}</span>
                  <span className="text-sm text-gray-500 ml-auto">{item.timestamp}</span>
                </div>
              </div>

              {/* Response */}
              <div className="p-6">
                <div className="flex items-start space-x-3">
                  <Bot className="w-5 h-5 text-green-600 mt-1 flex-shrink-0" />
                  <div className="flex-1">
                    {item.response.error ? (
                      <div className="flex items-start space-x-2 text-red-600">
                        <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0" />
                        <div>
                          <p className="font-medium">Error</p>
                          <p className="text-sm">{item.response.error}</p>
                          {item.response.suggestions && (
                            <div className="mt-2">
                              <p className="text-sm font-medium">Try these instead:</p>
                              <ul className="text-sm list-disc list-inside">
                                {item.response.suggestions.map((suggestion, i) => (
                                  <li key={i}>{suggestion}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      </div>
                    ) : item.response.data && item.response.data.length > 0 ? (
                      <div>
                        <div className="flex items-center space-x-2 mb-4">
                          <CheckCircle className="w-5 h-5 text-green-600" />
                          <span className="font-medium">
                            Found {item.response.data.length} job{item.response.data.length !== 1 ? 's' : ''}
                          </span>
                        </div>
                        <div className="space-y-3">
                          {item.response.data.map(formatJobSummary)}
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center space-x-2 text-gray-600">
                        <Clock className="w-5 h-5" />
                        <span>No jobs found matching your criteria</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {responses.length === 0 && (
          <div className="bg-white rounded-lg shadow p-8 text-center">
            <Bot className="w-16 h-16 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">Ready to Help</h3>
            <p className="text-gray-600 mb-4">
              Ask me anything about your jobs using natural language.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
              <div className="flex items-center justify-center space-x-2 text-green-600">
                <CheckCircle className="w-5 h-5" />
                <span>Location-based queries</span>
              </div>
              <div className="flex items-center justify-center space-x-2 text-blue-600">
                <Clock className="w-5 h-5" />
                <span>Time & urgency filters</span>
              </div>
              <div className="flex items-center justify-center space-x-2 text-purple-600">
                <DollarSign className="w-5 h-5" />
                <span>Profit optimization</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}