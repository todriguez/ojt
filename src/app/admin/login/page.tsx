'use client';

import AdminLogin from '@/components/AdminLogin';

export default function AdminLoginPage() {
  return <AdminLogin onLoginSuccess={() => {
    // Cookie is set by the server — redirect to admin dashboard
    window.location.href = '/admin';
  }} />;
}
