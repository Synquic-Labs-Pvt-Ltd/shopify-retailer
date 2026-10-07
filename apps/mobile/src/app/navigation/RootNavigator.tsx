import { DefaultTheme, NavigationContainer, type Theme } from '@react-navigation/native';
import { createNativeStackNavigator, type NativeStackNavigationOptions } from '@react-navigation/native-stack';
import { LoginScreen } from '../../features/auth/LoginScreen';
import { BatchDetailScreen } from '../../features/queue/BatchDetailScreen';
import { ReferencesScreen } from '../../features/references/ReferencesScreen';
import { ItemResultsScreen } from '../../features/results/ItemResultsScreen';
import { MediaViewerScreen } from '../../features/results/MediaViewerScreen';
import { colors } from '../../design';
import { selectIsSignedIn, useAuthStore } from '../../state/auth';
import { TabNavigator } from './TabNavigator';
import type { AuthStackParamList, MainStackParamList } from './types';

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const MainStack = createNativeStackNavigator<MainStackParamList>();

const navigationTheme: Theme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: colors.accent,
    background: colors.canvas,
    card: colors.surface,
    text: colors.ink,
    border: colors.hairline,
  },
};

// Headers hidden everywhere, canvas scene background, slide_from_right with swipe back.
const screenOptions: NativeStackNavigationOptions = {
  headerShown: false,
  animation: 'slide_from_right',
  gestureEnabled: true,
  contentStyle: { backgroundColor: colors.canvas },
};

export function RootNavigator() {
  const signedIn = useAuthStore(selectIsSignedIn);

  return (
    <NavigationContainer theme={navigationTheme}>
      {signedIn ? (
        <MainStack.Navigator screenOptions={screenOptions}>
          <MainStack.Screen name="Tabs" component={TabNavigator} />
          <MainStack.Screen name="References" component={ReferencesScreen} />
          <MainStack.Screen name="BatchDetail" component={BatchDetailScreen} />
          <MainStack.Screen name="ItemResults" component={ItemResultsScreen} />
          <MainStack.Screen
            name="MediaViewer"
            component={MediaViewerScreen}
            options={{ animation: 'fade', contentStyle: { backgroundColor: colors.viewerBackground } }}
          />
        </MainStack.Navigator>
      ) : (
        <AuthStack.Navigator screenOptions={screenOptions}>
          <AuthStack.Screen name="Login" component={LoginScreen} />
        </AuthStack.Navigator>
      )}
    </NavigationContainer>
  );
}
