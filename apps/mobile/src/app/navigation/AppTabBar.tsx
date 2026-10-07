import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { CommonActions } from '@react-navigation/native';
import { FloatingTabBar, type FloatingTabItem, type IconName } from '../../design';

const ICONS: Record<string, IconName> = {
  Products: 'pricetags-outline',
  Queue: 'layers-outline',
  Account: 'person-outline',
};

// Adapts React Navigation's tab state to the design system's FloatingTabBar.
export function AppTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const tabs: FloatingTabItem[] = state.routes.map((route) => ({
    key: route.key,
    label: descriptors[route.key]?.options.title ?? route.name,
    icon: ICONS[route.name] ?? 'ellipse-outline',
  }));
  const activeKey = state.routes[state.index]?.key ?? '';

  const select = (key: string) => {
    const route = state.routes.find((candidate) => candidate.key === key);
    if (route === undefined) return;
    const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
    if (key !== activeKey && !event.defaultPrevented) {
      navigation.dispatch({ ...CommonActions.navigate({ name: route.name, params: route.params }), target: state.key });
    }
  };

  return <FloatingTabBar tabs={tabs} activeKey={activeKey} onSelect={select} />;
}
