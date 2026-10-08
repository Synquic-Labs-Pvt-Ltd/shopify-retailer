'use client';

import { useLayoutEffect, useRef } from 'react';
import { useElementEvent } from '@/components/polaris/useElementEvent';

interface SelectCheckboxProps {
  checked: boolean;
  indeterminate?: boolean;
  // Read by screen readers; the box has no visible text.
  label: string;
  disabled?: boolean;
  onToggle: (checked: boolean) => void;
}

// A checkbox controlled by its props. The element flips itself when clicked, so once React has rendered the
// outcome (or left it unchanged because the change was refused) the element is put back to what the props say.
export function SelectCheckbox({ checked, indeterminate = false, label, disabled = false, onToggle }: SelectCheckboxProps) {
  const ref = useRef<HTMLElementTagNameMap['s-checkbox']>(null);
  const shown = useRef({ checked, indeterminate });
  useLayoutEffect(() => {
    shown.current = { checked, indeterminate };
  });

  useElementEvent(ref, 'change', (element) => {
    onToggle(element.checked);
    queueMicrotask(() => {
      element.checked = shown.current.checked;
      element.indeterminate = shown.current.indeterminate;
    });
  });

  return <s-checkbox ref={ref} checked={checked} indeterminate={indeterminate} disabled={disabled} accessibilityLabel={label} />;
}
