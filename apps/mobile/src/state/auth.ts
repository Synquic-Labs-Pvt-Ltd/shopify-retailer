import { create } from 'zustand';
import type { AuthSessionResponse } from '@rs/shared';

// In-memory session. The refresh token is mirrored to expo-secure-store by the auth feature
// (features/auth/authService.ts), which also fills this store at app start.
export interface AuthState {
  // False until the stored refresh token has been tried at app start. The auth gate renders nothing before that.
  bootstrapped: boolean;
  session: AuthSessionResponse | null;
  setSession: (session: AuthSessionResponse) => void;
  clearSession: () => void;
  markBootstrapped: () => void;
}

export const useAuthStore = create<AuthState>()((set) => ({
  bootstrapped: false,
  session: null,
  setSession: (session) => set({ session }),
  clearSession: () => set({ session: null }),
  markBootstrapped: () => set({ bootstrapped: true }),
}));

export const selectIsSignedIn = (state: AuthState): boolean => state.session !== null;
export const selectIsBootstrapped = (state: AuthState): boolean => state.bootstrapped;
