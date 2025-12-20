import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  User
} from 'firebase/auth';
import { auth } from './firebase';

// Admin email from environment
const ADMIN_EMAIL = process.env.NEXT_PUBLIC_ADMIN_EMAIL || 'todd@oddjobtodd.info';

// Sign in with email and password
export async function signIn(email: string, password: string): Promise<User> {
  // Only allow admin email to sign in
  if (email !== ADMIN_EMAIL) {
    throw new Error('Unauthorized: Only admin can access this system');
  }

  const userCredential = await signInWithEmailAndPassword(auth, email, password);
  return userCredential.user;
}

// Sign out
export async function signOutUser(): Promise<void> {
  await signOut(auth);
}

// Check if user is admin
export function isAdminUser(user: User | null): boolean {
  return user?.email === ADMIN_EMAIL;
}

// Auth state listener
export function onAuthStateChange(callback: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth, callback);
}

// Get current user
export function getCurrentUser(): User | null {
  return auth.currentUser;
}

// Check if user is authenticated and is admin
export function isAuthenticated(): boolean {
  const user = getCurrentUser();
  return user !== null && isAdminUser(user);
}