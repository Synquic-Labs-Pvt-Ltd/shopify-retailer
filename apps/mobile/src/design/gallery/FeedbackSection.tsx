import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  Banner,
  BottomSheet,
  BottomSheetOption,
  EmptyState,
  InkActivityIndicator,
  PrimaryButton,
  ProgressBar,
  Skeleton,
  Spinner,
  StatusChip,
  StatusTicker,
  colors,
  radii,
  spacing,
  useToast,
  type Tone,
} from '..';
import { GalleryItem, GallerySection } from './GallerySection';

const TONES: readonly Tone[] = ['neutral', 'pending', 'success', 'warning', 'danger'];
const TICKER_MESSAGES = ['Planning shots', 'Generating images', 'Rendering video', 'Saving to your store'];

export function FeedbackSection() {
  const toast = useToast();
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <>
      <GallerySection title="STATUS CHIP">
        <View style={styles.row}>
          {TONES.map((tone) => (
            <StatusChip key={tone} label={tone === 'pending' ? 'in_progress' : tone} tone={tone} />
          ))}
        </View>
      </GallerySection>

      <GallerySection title="BANNER">
        <Banner tone="warning" message="2 products need a reference. Add references to each product or add a common reference." />
        <Banner tone="danger" title="Provider busy" message="Resumes around 14:30." actionLabel="View details" onAction={() => toast.show('Action tapped')} />
        <Banner tone="success" message="Generation queued." />
        <Banner tone="neutral" message="Each product gets 2 images and 1 video." />
        <Banner tone="pending" message="Waiting for the provider." />
      </GallerySection>

      <GallerySection title="TOAST AND BOTTOM SHEET">
        <View style={styles.row}>
          <PrimaryButton label="Success" tone="surface" style={styles.half} onPress={() => toast.success('Saved to gallery')} />
          <PrimaryButton label="Error" tone="surface" style={styles.half} onPress={() => toast.error('Could not save the file')} />
        </View>
        <View style={styles.row}>
          <PrimaryButton label="Info" tone="surface" style={styles.half} onPress={() => toast.show('Generation queued')} />
          <PrimaryButton label="Bottom sheet" tone="ink" style={styles.half} onPress={() => setSheetOpen(true)} />
        </View>
        <BottomSheet visible={sheetOpen} onClose={() => setSheetOpen(false)} title="Add reference">
          <BottomSheetOption label="Take photo" icon="camera-outline" onPress={() => setSheetOpen(false)} />
          <BottomSheetOption label="Record video" icon="videocam-outline" onPress={() => setSheetOpen(false)} />
          <BottomSheetOption label="Choose photos or videos" icon="images-outline" onPress={() => setSheetOpen(false)} />
          <BottomSheetOption label="Delete everything" icon="trash-outline" danger onPress={() => setSheetOpen(false)} />
          <PrimaryButton label="Cancel" tone="ghost" onPress={() => setSheetOpen(false)} />
        </BottomSheet>
      </GallerySection>

      <GallerySection title="EMPTY STATE">
        <EmptyState icon="layers-outline" title="No generations yet" message="Pick a product to create your first batch." actionLabel="Go to Products" onAction={() => toast.show('Go to Products')} />
        <EmptyState icon="search-outline" title="No products found" />
      </GallerySection>

      <GallerySection title="SKELETON">
        <View style={styles.skeletonRow}>
          <Skeleton width={52} height={52} />
          <View style={styles.skeletonText}>
            <Skeleton width="70%" height={16} />
            <Skeleton width="40%" height={12} />
          </View>
          <Skeleton width={24} height={24} radius={radii.pill} />
        </View>
        <Skeleton height={120} radius={radii.card} />
      </GallerySection>

      <GallerySection title="PROGRESS">
        <GalleryItem caption="Spinner ring 64 pt, and 24 pt">
          <View style={styles.row}>
            <Spinner />
            <Spinner size={24} />
            <InkActivityIndicator />
          </View>
        </GalleryItem>
        <GalleryItem caption="ProgressBar 0, 35, 70, 100 percent">
          <ProgressBar progress={0} />
          <ProgressBar progress={0.35} />
          <ProgressBar progress={0.7} />
          <ProgressBar progress={1} />
        </GalleryItem>
      </GallerySection>

      <GallerySection title="STATUS TICKER">
        <StatusTicker messages={TICKER_MESSAGES} />
      </GallerySection>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.md },
  half: { flex: 1 },
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radii.card,
    backgroundColor: colors.surface,
  },
  skeletonText: { flex: 1, gap: spacing.sm },
});
