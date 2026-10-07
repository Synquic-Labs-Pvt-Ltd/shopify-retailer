import { useNavigation } from '@react-navigation/native';
import { ScrollView, StyleSheet } from 'react-native';
import { Screen, ScreenHeader, layout } from '..';
import { ControlsSection } from './ControlsSection';
import { FeedbackSection } from './FeedbackSection';
import { FoundationsSection } from './FoundationsSection';
import { MediaSection } from './MediaSection';

// Development only: every design system component in all of its states. Reached by long-pressing the
// title of the Account screen, and registered in the navigator only when __DEV__ is true.
export function DesignGalleryScreen() {
  const navigation = useNavigation();

  return (
    <Screen>
      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
      >
        <ScreenHeader overline="DEV ONLY" title="Design gallery" onBack={() => navigation.goBack()} />
        <ControlsSection />
        <FeedbackSection />
        <MediaSection />
        <FoundationsSection />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: layout.sectionGapMax + 8, paddingBottom: layout.tabScreenBottomPaddingMin },
});
