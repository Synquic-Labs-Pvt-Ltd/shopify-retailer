'use client';

import { useRef } from 'react';
import { useElementEvent } from '@/components/polaris/useElementEvent';

interface PromptTextAreaProps {
  label: string;
  value: string;
  rows: number;
  // Hint under the field, here the character count.
  details?: string;
  // Absent for a read-only preview.
  onChange?: (value: string) => void;
}

// A multi-line field controlled by its props. The element reports what is typed through the native `input` and
// `change` events, which are listened to by hand.
export function PromptTextArea({ label, value, rows, details, onChange }: PromptTextAreaProps) {
  const ref = useRef<HTMLElementTagNameMap['s-text-area']>(null);
  const update = (element: HTMLElementTagNameMap['s-text-area']): void => onChange?.(element.value);
  useElementEvent(ref, 'input', update);
  useElementEvent(ref, 'change', update);

  return (
    <s-text-area ref={ref} label={label} value={value} rows={rows} readOnly={onChange === undefined} details={details} />
  );
}

interface PromptNoteFieldProps {
  value: string;
  maxLength: number;
  disabled: boolean;
  onChange: (value: string) => void;
}

// The short note saved with a version: what was changed and why.
export function PromptNoteField({ value, maxLength, disabled, onChange }: PromptNoteFieldProps) {
  const ref = useRef<HTMLElementTagNameMap['s-text-field']>(null);
  const update = (element: HTMLElementTagNameMap['s-text-field']): void => onChange(element.value);
  useElementEvent(ref, 'input', update);
  useElementEvent(ref, 'change', update);

  return (
    <s-text-field
      ref={ref}
      label="Note (optional)"
      placeholder="What did you change?"
      value={value}
      maxLength={maxLength}
      disabled={disabled}
      details="Saved with the version, so you can tell the versions apart later."
    />
  );
}
