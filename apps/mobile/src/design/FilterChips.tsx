import { ScrollView, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { AppText } from './AppText';
import { PressableScale } from './PressableScale';
import { colors, components, layout, pressScale, radii, spacing } from './theme';

export interface FilterChipOption<T extends string> {
  value: T;
  label: string;
}

export interface FilterChipsProps<T extends string> {
  options: readonly FilterChipOption<T>[];
  value: T;
  onChange: (value: T) => void;
  // How far the row bleeds past its parent on both sides. Defaults to the 24 pt screen padding.
  bleed?: number;
  style?: StyleProp<ViewStyle>;
}

// A horizontal scroll bleeding to the screen edges, 38 pt tall. Active is black, idle is white.
export function FilterChips<T extends string>({
  options,
  value,
  onChange,
  bleed = layout.screenPaddingX,
  style,
}: FilterChipsProps<T>) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={[{ marginHorizontal: -bleed, flexGrow: 0 }, style]}
      contentContainerStyle={[styles.content, { paddingHorizontal: bleed }]}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <PressableScale
            key={option.value}
            scale={pressScale.filterChip}
            haptic="selection"
            onPress={() => onChange(option.value)}
            accessibilityState={{ selected: active }}
            style={[styles.chip, { backgroundColor: active ? colors.ink : colors.surface }]}
          >
            <AppText variant="chip" color={active ? colors.accentInk : colors.ink} numberOfLines={1}>
              {option.label}
            </AppText>
          </PressableScale>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.sm, alignItems: 'center' },
  chip: {
    height: components.filterChips.height,
    justifyContent: 'center',
    paddingHorizontal: components.chip.paddingX,
    borderRadius: radii.pill,
  },
});
