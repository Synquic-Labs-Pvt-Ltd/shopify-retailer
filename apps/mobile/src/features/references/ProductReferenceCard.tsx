import { StyleSheet, View } from 'react-native';
import { AppText, IconButton, Image, Panel, colors, components, radii, spacing } from '../../design';
import { ReferenceSlotRow } from './ReferenceSlotRow';
import type { ProductResolution } from './resolution';

export interface ProductReferenceCardProps {
  resolution: ProductResolution;
  // True when the product needs a reference, by the local rule or by the server's 422.
  unresolved: boolean;
  onAdd: () => void;
  onRetry: (clientId: string) => void;
  onRemove: (clientId: string) => void;
}

// One white card per selected product: thumbnail, resolution status and the per-product "+".
export function ProductReferenceCard({ resolution, unresolved, onAdd, onRetry, onRemove }: ProductReferenceCardProps) {
  const { product, own, label } = resolution;
  return (
    <Panel style={styles.card}>
      <View style={styles.head}>
        <Image uri={product.imageUrl} radius={radii.small} style={styles.thumbnail} />
        <View style={styles.text}>
          <AppText variant="cardTitle" numberOfLines={1}>
            {product.title}
          </AppText>
          <AppText variant="meta" color={unresolved ? colors.warning : colors.meta} numberOfLines={1}>
            {unresolved ? 'Needs a reference' : label}
          </AppText>
        </View>
        <IconButton
          icon="add-outline"
          accessibilityLabel={`Add references to ${product.title}`}
          onPress={onAdd}
          style={styles.add}
        />
      </View>
      {own.length > 0 && <ReferenceSlotRow refs={own} onRetry={onRetry} onRemove={onRemove} />}
    </Panel>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.md },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  thumbnail: { width: components.listRow.thumbnailSize, height: components.listRow.thumbnailSize },
  text: { flex: 1, gap: spacing.xs / 2 },
  add: { backgroundColor: colors.canvas },
});
