import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { AccountScreen } from '../../features/account/AccountScreen';
import { ProductsScreen } from '../../features/products/ProductsScreen';
import { QueueScreen } from '../../features/queue/QueueScreen';
import { AppTabBar } from './AppTabBar';
import type { TabParamList } from './types';

const Tab = createBottomTabNavigator<TabParamList>();

export function TabNavigator() {
  return (
    <Tab.Navigator screenOptions={{ headerShown: false }} tabBar={(props) => <AppTabBar {...props} />}>
      <Tab.Screen name="Products" component={ProductsScreen} />
      <Tab.Screen name="Queue" component={QueueScreen} />
      <Tab.Screen name="Account" component={AccountScreen} />
    </Tab.Navigator>
  );
}
