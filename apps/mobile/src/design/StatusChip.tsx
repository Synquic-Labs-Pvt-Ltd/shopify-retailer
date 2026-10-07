import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { AppText } from './AppText';
import { components, radii } from './theme';
import { toneColors, type Tone } from './tones';

export interface StatusChipProps {
  // Shown capitalized. Underscores become spaces, so enum values can be passed as they are.
  label: string;
  tone?: Tone;
  style?: StyleProp<ViewStyle>;
}

// A pill with 10x3 padding and 11 pt capitalized text, tinted by tone.
export function StatusChip({ label, tone = 'neutral', style }: StatusChipProps) {
  const colorsForTone = toneColors[tone];
  return (
    <View style={[styles.chip, { backgroundColor: colorsForTone.tint }, style]}>
      <AppText variant="pillSmall" color={colorsForTone.text} numberOfLines={1} style={styles.label}>
        {label.replace(/_/g, ' ')}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignSelf: 'flex-start',
    paddingHorizontal: components.statusChip.paddingX,
    paddingVertical: components.statusChip.paddingY,
    borderRadius: radii.pill,
  },
  label: { textTransform: 'capitalize' },
});
