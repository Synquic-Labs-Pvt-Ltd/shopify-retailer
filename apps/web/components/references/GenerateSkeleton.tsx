type Size = `${number}px` | `${number}%`;

function Bar({ width, height = '14px' }: { width: Size; height?: Size }) {
  return <s-box background="subdued" borderRadius="base" inlineSize={width} blockSize={height} />;
}

// Shown until the persisted draft has been read, so the page never flashes an empty selection.
export function GenerateSkeleton() {
  return (
    <s-page heading="New generation">
      <s-section heading="Common references">
        <s-stack gap="base">
          <Bar width="320px" />
          <Bar width="100%" height="100px" />
        </s-stack>
      </s-section>
      <s-section heading="Products">
        <s-stack gap="base">
          {[0, 1, 2].map((row) => (
            <s-stack key={row} direction="inline" alignItems="center" gap="base">
              <Bar width="40px" height="40px" />
              <s-stack gap="small-200">
                <Bar width="200px" />
                <Bar width="90px" />
              </s-stack>
            </s-stack>
          ))}
        </s-stack>
      </s-section>
      <s-section slot="aside" heading="Summary">
        <s-stack gap="small">
          <Bar width="100%" />
          <Bar width="100%" />
          <Bar width="100%" />
        </s-stack>
      </s-section>
    </s-page>
  );
}
