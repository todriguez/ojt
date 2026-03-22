'use client';

import React, { useState, useEffect } from 'react';
import AdminDashboard from '@/components/AdminDashboard';

/**
 * Admin page — checks auth via /api/v2/auth/me.
 * No Firebase dependency.
 */
export default function AdminPage() {
  const [user, setUser] = useState<{ email: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/v2/auth/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.authenticated && data.type === 'admin') {
          setUser({ email: data.email });
        } else {
          window.location.href = '/admin/login';
        }
      })
      .catch(() => {
        window.location.href = '/admin/login';
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading || !user) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-orange-500 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  return <AdminDashboard user={user} />;
}
