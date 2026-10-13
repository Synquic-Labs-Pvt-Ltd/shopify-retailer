'use client';

import { use } from 'react';
import { PromptEditorView } from '@/components/prompts/PromptEditorView';

export default function PromptEditorPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  return <PromptEditorView name={name} />;
}
