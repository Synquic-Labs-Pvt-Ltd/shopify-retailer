'use client';

import type { StyleMode } from '@rs/shared';
import { STYLE_MODE_LABELS, STYLE_MODE_OPTIONS } from '@/lib/references/resolution';

interface AestheticSectionProps {
  styleMode: StyleMode;
  onChange: (mode: StyleMode) => void;
}

// The batch-level aesthetic: where every product's look comes from unless a product sets its own. Only
// "Custom references" needs an upload, so the default "From the apparel" generates with nothing added.
export function AestheticSection({ styleMode, onChange }: AestheticSectionProps) {
  return (
    <s-section
      heading="Aesthetic"
      subheading="Where the look comes from. Generate with no uploads, or pick Custom references to drive the look from images you add below."
    >
      <s-stack direction="inline" alignItems="center" gap="small-200">
        {STYLE_MODE_OPTIONS.map((mode) => {
          const selected = mode === styleMode;
          const label = STYLE_MODE_LABELS[mode];
          return (
            <s-clickable-chip
              key={mode}
              color={selected ? 'strong' : 'base'}
              accessibilityLabel={selected ? `${label}, selected` : label}
              onClick={() => onChange(mode)}
            >
              {label}
            </s-clickable-chip>
          );
        })}
      </s-stack>
    </s-section>
  );
}
