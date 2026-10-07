import { StyleSheet, View } from 'react-native';
import { Skeleton, colors, components, radii, spacing } from '../../design';

const ROWS = 7;

// Placeholder rows with the shape of a ProductRow while the first page loads.
export function ProductListSkeleton() {
  return (
    <View style={styles.list}>
      {Array.from({ length: ROWS }, (_, index) => (
        <View key={index} style={styles.row}>
          <Skeleton
            width={components.listRow.thumbnailSize}
            height={components.listRow.thumbnailSize}
            radius={radii.small}
          />
          <View style={styles.text}>
            <Skeleton width="70%" height={16} />
            <Skeleton width="40%" height={12} />
          </View>
          <Skeleton width={24} height={24} radius={12} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: components.listRow.gap,
    padding: components.listRow.padding,
    borderRadius: components.listRow.radius,
    backgroundColor: colors.surface,
  },
  text: { flex: 1, gap: spacing.sm },
});
