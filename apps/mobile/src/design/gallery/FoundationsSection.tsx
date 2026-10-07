import { StyleSheet, View } from 'react-native';
import { AppText, colors, radii, spacing, typography, type ColorName, type TypographyName } from '..';
import { GalleryItem, GallerySection } from './GallerySection';

const SWATCHES: readonly ColorName[] = [
  'canvas',
  'surface',
  'ink',
  'inkMuted',
  'meta',
  'cardGray',
  'cardGrayGraphic',
  'danger',
  'success',
  'warning',
  'scrim',
  'hairline',
  'tintNeutral',
  'tintSuccess',
  'tintDanger',
  'tintWarning',
];

const TYPE_SAMPLES: readonly { variant: TypographyName; text: string }[] = [
  { variant: 'display', text: 'Display' },
  { variant: 'hero', text: 'Log in' },
  { variant: 'pageTitle', text: 'Page title' },
  { variant: 'sheetTitle', text: 'Sheet title' },
  { variant: 'cardTitle', text: 'Card title' },
  { variant: 'sectionLabel', text: 'Section label' },
  { variant: 'body', text: 'Body text for longer reading.' },
  { variant: 'bodyMedium', text: 'Body medium text.' },
  { variant: 'meta', text: 'Meta text' },
  { variant: 'button', text: 'Button label' },
  { variant: 'navLabelTab', text: 'Tab label' },
  { variant: 'chip', text: 'Chip label' },
  { variant: 'pillSmall', text: 'Pill small' },
  { variant: 'metric', text: '1,284' },
];

export function FoundationsSection() {
  return (
    <>
      <GallerySection title="COLOR TOKENS">
        <View style={styles.swatches}>
          {SWATCHES.map((name) => (
            <View key={name} style={styles.swatch}>
              <View style={[styles.chip, { backgroundColor: colors[name] }]} />
              <AppText variant="meta" color={colors.meta} numberOfLines={1}>
                {name}
              </AppText>
            </View>
          ))}
        </View>
      </GallerySection>
      <GallerySection title="TYPOGRAPHY">
        {TYPE_SAMPLES.map((sample) => (
          <GalleryItem key={sample.variant} caption={`${sample.variant}  ${typography[sample.variant].fontSize} pt`}>
            <AppText variant={sample.variant}>{sample.text}</AppText>
          </GalleryItem>
        ))}
      </GallerySection>
    </>
  );
}

const styles = StyleSheet.create({
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm + spacing.xs },
  swatch: { width: 72, gap: spacing.xs },
  chip: { height: 40, borderRadius: radii.small, borderWidth: 1, borderColor: colors.hairline },
});
