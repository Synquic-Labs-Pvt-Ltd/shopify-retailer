'use client';

import { use } from 'react';
import { BatchDetailView } from '@/components/generations/BatchDetailView';

export default function GenerationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <BatchDetailView id={id} />;
}
