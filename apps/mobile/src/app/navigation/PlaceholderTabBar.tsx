import Ionicons from '@expo/vector-icons/Ionicons';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { CommonActions } from '@react-navigation/native';
import type { ComponentProps } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText, PressableScale, colors, components, shadows } from '../../design';

type IconName = ComponentProps<typeof Ionicons>['name'];

const ICONS: Record<string, IconName> = {
  Products: 'pricetags-outline',
  Queue: 'layers-outline',
  Account: 'person-outline',
};

// Plain placeholder. The floating pill tab bar is part of the design system work.
export function PlaceholderTabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, components.floatingTabBar.minBottomInset) }]}>
      {state.routes.map((route, index) => {
        const focused = state.index === index;
        const tint = focused ? colors.ink : colors.inkMuted;
        const onPress = () => {
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) {
            navigation.dispatch({ ...CommonActions.navigate({ name: route.name, params: route.params }), target: state.key });
          }
        };
        return (
          <PressableScale key={route.key} style={styles.item} onPress={onPress} accessibilityState={{ selected: focused }}>
            <Ionicons name={ICONS[route.name] ?? 'ellipse-outline'} size={components.floatingTabBar.iconSize} color={tint} />
            <AppText variant="navLabelTab" color={tint}>
              {route.name}
            </AppText>
          </PressableScale>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    paddingTop: 10,
    ...shadows.tabBar,
  },
  item: { flex: 1, alignItems: 'center', gap: 2 },
});
