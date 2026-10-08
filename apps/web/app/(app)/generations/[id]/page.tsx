'use client';

import { use } from 'react';

export default function GenerationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <s-page heading={`Generation ${id}`}>
      <s-section>
        <s-paragraph>Generation detail (placeholder, replaced by the Generation detail page track).</s-paragraph>
      </s-section>
    </s-page>
  );
}
