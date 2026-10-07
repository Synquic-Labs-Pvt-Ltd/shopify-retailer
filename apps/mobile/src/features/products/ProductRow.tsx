import { memo } from 'react';
import type { ProductListItem } from '@rs/shared';
import { ListRow } from '../../design';
import { SelectionCircle } from './SelectionCircle';

export interface ProductRowProps {
  product: ProductListItem;
  selected: boolean;
  onToggle: (product: ProductListItem) => void;
}

function hintOf(product: ProductListItem): string {
  const media = `${product.mediaCount} media`;
  return product.vendor === '' ? media : `${media} · ${product.vendor}`;
}

// A ListRow-style product: 52 pt thumbnail, title, "{mediaCount} media · {vendor}" and the selection circle.
export const ProductRow = memo(function ProductRow({ product, selected, onToggle }: ProductRowProps) {
  return (
    <ListRow
      label={product.title}
      hint={hintOf(product)}
      thumbnailUri={product.imageUrl}
      haptic="selection"
      accessibilityLabel={`${product.title}, ${selected ? 'selected' : 'not selected'}`}
      trailing={<SelectionCircle selected={selected} />}
      onPress={() => onToggle(product)}
    />
  );
});
