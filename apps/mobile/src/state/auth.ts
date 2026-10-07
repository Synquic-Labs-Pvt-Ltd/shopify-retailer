import { create } from 'zustand';
import type { AuthSessionResponse } from '@rs/shared';

// In-memory session. Persisting the refresh token to expo-secure-store is part of the auth feature.
export interface AuthState {
  session: AuthSessionResponse | null;
  setSession: (session: AuthSessionResponse) => void;
  clearSession: () => void;
}

export const useAuthStore = create<AuthState>()((set) => ({
  session: null,
  setSession: (session) => set({ session }),
  clearSession: () => set({ session: null }),
}));

export const selectIsSignedIn = (state: AuthState): boolean => state.session !== null;
