import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { Inter_700Bold } from '@expo-google-fonts/inter/700Bold';
import { Inter_800ExtraBold } from '@expo-google-fonts/inter/800ExtraBold';
import { Inter_900Black } from '@expo-google-fonts/inter/900Black';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { fontFamily } from '../design';
import { RootNavigator } from './navigation/RootNavigator';
import { AppProviders } from './providers';

// Per-weight imports keep the other twelve Inter files (thin, light, italics) out of the bundle.
export function App() {
  const [fontsLoaded, fontError] = useFonts({
    [fontFamily.regular]: Inter_400Regular,
    [fontFamily.medium]: Inter_500Medium,
    [fontFamily.semiBold]: Inter_600SemiBold,
    [fontFamily.bold]: Inter_700Bold,
    [fontFamily.extraBold]: Inter_800ExtraBold,
    [fontFamily.black]: Inter_900Black,
  });

  // Show nothing until Inter has loaded. A font error falls through to the system font.
  if (!fontsLoaded && fontError === null) return null;

  return (
    <AppProviders>
      <StatusBar style="dark" />
      <RootNavigator />
    </AppProviders>
  );
}
