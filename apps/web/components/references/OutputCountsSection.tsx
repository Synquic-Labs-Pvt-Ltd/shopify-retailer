'use client';

interface CountChipsProps {
  min: number;
  max: number;
  value: number;
  onChange: (count: number) => void;
}

function CountChips({ min, max, value, onChange }: CountChipsProps) {
  const options = Array.from({ length: max - min + 1 }, (_unused, index) => min + index);
  return (
    <s-stack direction="inline" alignItems="center" gap="small-200">
      {options.map((count) => {
        const selected = count === value;
        return (
          <s-clickable-chip
            key={count}
            color={selected ? 'strong' : 'subdued'}
            accessibilityLabel={selected ? `${count}, selected` : `${count}`}
            onClick={() => onChange(count)}
          >
            {selected ? <s-icon slot="graphic" type="check" /> : null}
            {count}
          </s-clickable-chip>
        );
      })}
    </s-stack>
  );
}

interface OutputCountsSectionProps {
  maxImages: number;
  maxVideos: number;
  imagesPerProduct: number;
  videosPerProduct: number;
  onImagesChange: (count: number) => void;
  onVideosChange: (count: number) => void;
}

// How many images and videos each product gets, up to the shop's configured maximum (the shop's configured
// outputs.imagesPerProduct/videosPerProduct is both the default and the ceiling a merchant can pick for a batch).
export function OutputCountsSection({
  maxImages,
  maxVideos,
  imagesPerProduct,
  videosPerProduct,
  onImagesChange,
  onVideosChange,
}: OutputCountsSectionProps) {
  return (
    <s-section heading="Outputs" subheading={`Choose how many images (up to ${maxImages}) and videos (up to ${maxVideos}) each product gets.`}>
      <s-stack gap="base">
        <s-stack gap="small-200">
          <s-text color="subdued">Images per product</s-text>
          <CountChips min={1} max={maxImages} value={imagesPerProduct} onChange={onImagesChange} />
        </s-stack>
        <s-stack gap="small-200">
          <s-text color="subdued">Videos per product</s-text>
          <CountChips min={0} max={maxVideos} value={videosPerProduct} onChange={onVideosChange} />
        </s-stack>
      </s-stack>
    </s-section>
  );
}
