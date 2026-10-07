import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { AppText, colors, spacing } from '..';

export function GallerySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <AppText variant="sectionLabel" color={colors.meta}>
        {title}
      </AppText>
      <View style={styles.body}>{children}</View>
    </View>
  );
}

// A captioned sample inside a section.
export function GalleryItem({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <View style={styles.item}>
      <AppText variant="meta" color={colors.meta}>
        {caption}
      </AppText>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm + spacing.xs },
  body: { gap: spacing.md },
  item: { gap: spacing.sm },
});
