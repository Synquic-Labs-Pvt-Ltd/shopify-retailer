import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  Chip,
  Field,
  FilterChips,
  IconButton,
  PrimaryButton,
  SegmentedControl,
  spacing,
  type ButtonTone,
} from '..';
import { GalleryItem, GallerySection } from './GallerySection';

const TONES: readonly ButtonTone[] = ['accent', 'ink', 'danger', 'surface', 'ghost'];
const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'draft', label: 'Draft' },
  { value: 'archived', label: 'Archived' },
  { value: 'gift', label: 'Gift cards' },
  { value: 'bundle', label: 'Bundles' },
] as const;
const SEGMENTS = [
  { value: 'images', label: 'Images' },
  { value: 'videos', label: 'Videos' },
  { value: 'all', label: 'All' },
] as const;

export function ControlsSection() {
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['value']>('all');
  const [segment, setSegment] = useState<(typeof SEGMENTS)[number]['value']>('images');
  const [chipOn, setChipOn] = useState(true);
  const [text, setText] = useState('');

  const toggleLoading = () => {
    setLoading(true);
    setTimeout(() => setLoading(false), 1800);
  };

  return (
    <>
      <GallerySection title="PRIMARY BUTTON">
        {TONES.map((tone) => (
          <PrimaryButton key={tone} label={`Tone: ${tone}`} tone={tone} />
        ))}
        <PrimaryButton label="Loading (tap to try)" loading={loading} onPress={toggleLoading} />
        <PrimaryButton label="Disabled" disabled />
        <PrimaryButton label="Ghost loading" tone="ghost" loading />
      </GallerySection>

      <GallerySection title="ICON BUTTON">
        <View style={styles.row}>
          <IconButton icon="add-outline" accessibilityLabel="Add" />
          <IconButton icon="add-outline" primary accessibilityLabel="Add primary" />
          <IconButton icon="layers-outline" badgeCount={3} accessibilityLabel="Layers with badge" />
          <IconButton icon="layers-outline" badgeCount={120} accessibilityLabel="Layers with large badge" />
          <IconButton icon="notifications-outline" dot accessibilityLabel="Notifications with dot" />
          <IconButton icon="trash-outline" disabled accessibilityLabel="Disabled" />
        </View>
      </GallerySection>

      <GallerySection title="FIELD">
        <Field label="Default" placeholder="Placeholder" value={text} onChangeText={setText} />
        <Field label="Required" required placeholder="Required field" />
        <Field label="Boxed" boxed placeholder="Hairline border" />
        <Field label="Error" error="This value is not valid." defaultValue="my store" />
        <Field label="Read only" readOnly value="mock-store.myshopify.com" />
        <Field label="Password" secureTextEntry defaultValue="secret value" />
        <Field label="Store domain" suffix=".myshopify.com" placeholder="your-store" autoCapitalize="none" />
        <Field icon="search-outline" placeholder="Search products" boxed />
      </GallerySection>

      <GallerySection title="CHIPS AND SEGMENTS">
        <GalleryItem caption="Chip">
          <View style={styles.row}>
            <Chip label="Selected" selected={chipOn} onPress={() => setChipOn((value) => !value)} />
            <Chip label="Idle" selected={!chipOn} onPress={() => setChipOn((value) => !value)} />
          </View>
        </GalleryItem>
        <GalleryItem caption="FilterChips (bleeds to the screen edges)">
          <FilterChips options={FILTERS} value={filter} onChange={setFilter} />
        </GalleryItem>
        <GalleryItem caption="SegmentedControl">
          <SegmentedControl options={SEGMENTS} value={segment} onChange={setSegment} />
        </GalleryItem>
      </GallerySection>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.md },
});
