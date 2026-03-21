import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { jwtVerify } from 'jose';

/**
 * Admin layout — server-side session guard.
 *
 * The edge middleware already redirects unauthenticated requests,
 * but this provides defense-in-depth at the layout level.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The login page is not wrapped by this layout check —
  // middleware handles routing to /admin/login
  const cookieStore = await cookies();
  const token = cookieStore.get('ojt_admin_session')?.value;

  if (!token) {
    redirect('/admin/login');
  }

  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET || '');
    const { payload } = await jwtVerify(token, secret, { issuer: 'oddjobtodd' });
    if ((payload as Record<string, unknown>).type !== 'admin') {
      redirect('/admin/login');
    }
  } catch {
    // Try previous key
    const prevSecret = process.env.JWT_SECRET_PREVIOUS;
    if (prevSecret) {
      try {
        const secret = new TextEncoder().encode(prevSecret);
        const { payload } = await jwtVerify(token, secret, { issuer: 'oddjobtodd' });
        if ((payload as Record<string, unknown>).type !== 'admin') {
          redirect('/admin/login');
        }
      } catch {
        redirect('/admin/login');
      }
    } else {
      redirect('/admin/login');
    }
  }

  return <>{children}</>;
}
