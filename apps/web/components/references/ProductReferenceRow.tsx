'use client';

import { ProductThumb } from '@/components/products/ProductThumb';
import type { ProductResolution } from '@/lib/references/resolution';
import { AddFilesButton } from './AddFilesButton';
import { resolutionBadge } from './logic';
import { SlotList } from './SlotList';

interface ProductReferenceRowProps {
  resolution: ProductResolution;
  // The server named this product in a 422 references_required response.
  flaggedByServer: boolean;
  onFiles: (files: File[]) => void;
  onRetry: (clientId: string) => void;
  onRemove: (clientId: string) => void;
  onRemoveProduct: () => void;
}

// One selected product: picture, title, how its references resolve, its own photo slots and the controls to add
// photos or take the product out of this generation.
export function ProductReferenceRow({
  resolution,
  flaggedByServer,
  onFiles,
  onRetry,
  onRemove,
  onRemoveProduct,
}: ProductReferenceRowProps) {
  const { product, own } = resolution;
  const badge = resolutionBadge(resolution, flaggedByServer);

  return (
    <s-box padding="base">
      <s-grid gridTemplateColumns="auto 1fr auto" gap="base" alignItems="start">
        <ProductThumb imageUrl={product.imageUrl} title={product.title} />
        <s-stack gap="small-200">
          <s-text type="strong">{product.title}</s-text>
          <s-stack direction="inline">
            <s-badge tone={badge.tone}>{badge.label}</s-badge>
          </s-stack>
          <SlotList label={`Product photos of ${product.title}`} references={own} onRetry={onRetry} onRemove={onRemove} />
        </s-stack>
        <s-stack direction="inline" alignItems="center" gap="small-200">
          <AddFilesButton label="Add product photos" accessibilityLabel={`Add product photos to ${product.title}`} onFiles={onFiles} />
          <s-button
            variant="tertiary"
            icon="x"
            accessibilityLabel={`Remove ${product.title} from this generation`}
            onClick={onRemoveProduct}
          />
        </s-stack>
      </s-grid>
    </s-box>
  );
}
