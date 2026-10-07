import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';
import { PressableScale } from './PressableScale';
import { colors, components, radii, shadows } from './theme';

export interface FloatingTabItem {
  key: string;
  label: string;
  icon: IconName;
}

export interface FloatingTabBarProps {
  tabs: readonly FloatingTabItem[];
  activeKey: string;
  onSelect: (key: string) => void;
}

const { widthFraction, bottomOffset, minBottomInset, iconSize } = components.floatingTabBar;

// A white pill at 90% of the screen width, 8 pt above the safe area (minimum 10), with the tab bar shadow.
// It positions itself absolutely at the bottom of its parent.
export function FloatingTabBar({ tabs, activeKey, onSelect }: FloatingTabBarProps) {
  const insets = useSafeAreaInsets();

  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrapper, { bottom: Math.max(insets.bottom + bottomOffset, minBottomInset) }]}
    >
      <View accessibilityRole="tablist" style={styles.pill}>
        {tabs.map((tab) => {
          const focused = tab.key === activeKey;
          const tint = focused ? colors.ink : colors.inkMuted;
          return (
            <PressableScale
              key={tab.key}
              accessibilityRole="tab"
              accessibilityLabel={tab.label}
              accessibilityState={{ selected: focused }}
              onPress={() => onSelect(tab.key)}
              style={styles.item}
            >
              <Icon name={tab.icon} size={iconSize} color={tint} />
              <AppText variant="navLabelTab" color={tint}>
                {tab.label}
              </AppText>
            </PressableScale>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  pill: {
    flexDirection: 'row',
    width: `${widthFraction * 100}%`,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
    ...shadows.tabBar,
  },
  item: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: 2 },
});
