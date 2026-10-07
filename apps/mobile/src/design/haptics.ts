import * as Haptics from 'expo-haptics';
import type { HapticName } from './theme';

function safely(run: () => Promise<void>): void {
  run().catch(() => undefined);
}

export const haptics: Record<HapticName, () => void> = {
  light: () => safely(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  selection: () => safely(() => Haptics.selectionAsync()),
  medium: () => safely(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  success: () => safely(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  error: () => safely(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
};
