import { DefaultTheme, NavigationContainer, type Theme } from '@react-navigation/native';
import { createNativeStackNavigator, type NativeStackNavigationOptions } from '@react-navigation/native-stack';
import { useEffect } from 'react';
import { bootstrapAuth } from '../../features/auth/authService';
import { LoginScreen } from '../../features/auth/LoginScreen';
import { BatchDetailScreen } from '../../features/queue/BatchDetailScreen';
import { ReferencesScreen } from '../../features/references/ReferencesScreen';
import { ItemResultsScreen } from '../../features/results/ItemResultsScreen';
import { MediaViewerScreen } from '../../features/results/MediaViewerScreen';
import { colors } from '../../design';
import { selectIsBootstrapped, selectIsSignedIn, useAuthStore } from '../../state/auth';
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

// The gallery is required lazily so release builds (where __DEV__ is false) do not bundle it.
const DesignGalleryScreen = __DEV__
  ? (require('../../design/gallery/DesignGalleryScreen') as typeof import('../../design/gallery/DesignGalleryScreen'))
      .DesignGalleryScreen
  : null;

// Headers hidden everywhere, canvas scene background, slide_from_right with swipe back.
const screenOptions: NativeStackNavigationOptions = {
  headerShown: false,
  animation: 'slide_from_right',
  gestureEnabled: true,
  contentStyle: { backgroundColor: colors.canvas },
};

export function RootNavigator() {
  const bootstrapped = useAuthStore(selectIsBootstrapped);
  const signedIn = useAuthStore(selectIsSignedIn);

  useEffect(() => {
    void bootstrapAuth();
  }, []);

  // The auth gate shows nothing until the stored session has been tried.
  if (!bootstrapped) return null;

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
          {DesignGalleryScreen !== null && <MainStack.Screen name="DesignGallery" component={DesignGalleryScreen} />}
        </MainStack.Navigator>
      ) : (
        <AuthStack.Navigator screenOptions={screenOptions}>
          <AuthStack.Screen name="Login" component={LoginScreen} />
        </AuthStack.Navigator>
      )}
    </NavigationContainer>
  );
}
