// A product picture at the size of a list row, or a neutral tile when the product has no image.
export function ProductThumb({ imageUrl, title }: { imageUrl: string | null; title: string }) {
  if (imageUrl !== null) return <s-thumbnail src={imageUrl} alt={title} size="small" />;
  return (
    <s-box background="subdued" borderRadius="base" inlineSize="40px" blockSize="40px" padding="small-200">
      <s-icon type="image" />
    </s-box>
  );
}
