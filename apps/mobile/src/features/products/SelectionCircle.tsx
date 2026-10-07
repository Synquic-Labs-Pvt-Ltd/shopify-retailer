import { StyleSheet, View } from 'react-native';
import { Icon, borders, colors } from '../../design';

const SIZE = 24;

// The 24 pt selection mark of a product row: black with a white check, or a hairline outline.
export function SelectionCircle({ selected }: { selected: boolean }) {
  return (
    <View style={[styles.circle, selected ? styles.on : styles.off]}>
      {selected && <Icon name="checkmark-outline" size={16} color={colors.accentInk} />}
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { width: SIZE, height: SIZE, borderRadius: SIZE / 2, alignItems: 'center', justifyContent: 'center' },
  on: { backgroundColor: colors.ink, borderWidth: borders.outlineWidth, borderColor: colors.ink },
  off: { borderWidth: borders.outlineWidth, borderColor: colors.hairline },
});
