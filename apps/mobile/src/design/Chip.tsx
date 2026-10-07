import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { AppText } from './AppText';
import { PressableScale } from './PressableScale';
import { borders, colors, components, pressScale, radii } from './theme';

export interface ChipProps {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

// A pill with a 1.5 px border. Selected is a black fill with white text, idle is transparent with a hairline border.
export function Chip({ label, selected = false, onPress, disabled, style }: ChipProps) {
  return (
    <PressableScale
      scale={pressScale.chip}
      haptic="selection"
      disabled={disabled}
      onPress={onPress}
      accessibilityState={{ selected, disabled }}
      style={[styles.chip, selected ? styles.selected : styles.idle, style]}
    >
      <AppText variant="chip" color={selected ? colors.accentInk : colors.ink} numberOfLines={1}>
        {label}
      </AppText>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignSelf: 'flex-start',
    paddingHorizontal: components.chip.paddingX,
    paddingVertical: components.chip.paddingY,
    borderRadius: radii.pill,
    borderWidth: components.chip.borderWidth,
  },
  selected: { backgroundColor: colors.ink, borderColor: colors.ink },
  idle: { backgroundColor: 'transparent', borderColor: borders.hairlineColor },
});
