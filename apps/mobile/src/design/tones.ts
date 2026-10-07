import { colors } from './theme';

// Shared by StatusChip and Banner. neutral and pending share the 6% ink tint.
export type Tone = 'neutral' | 'pending' | 'success' | 'warning' | 'danger';

export interface ToneColors {
  tint: string;
  text: string;
}

export const toneColors: Record<Tone, ToneColors> = {
  neutral: { tint: colors.tintNeutral, text: colors.ink },
  pending: { tint: colors.tintPending, text: colors.meta },
  success: { tint: colors.tintSuccess, text: colors.success },
  warning: { tint: colors.tintWarning, text: colors.warning },
  danger: { tint: colors.tintDanger, text: colors.danger },
};
