import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { AppText } from './AppText';
import { PressableScale } from './PressableScale';
import { colors, components, pressScale, radii } from './theme';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  style?: StyleProp<ViewStyle>;
}

// A white pill track with 4 pt padding. The active segment is a black pill.
export function SegmentedControl<T extends string>({ options, value, onChange, style }: SegmentedControlProps<T>) {
  return (
    <View accessibilityRole="tablist" style={[styles.track, style]}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <PressableScale
            key={option.value}
            scale={pressScale.toggle}
            haptic="selection"
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(option.value)}
            style={[styles.segment, active && styles.active]}
          >
            <AppText variant="chip" color={active ? colors.accentInk : colors.ink} numberOfLines={1}>
              {option.label}
            </AppText>
          </PressableScale>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    padding: components.segmentedControl.trackPadding,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
  },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: radii.pill },
  active: { backgroundColor: colors.ink },
});
