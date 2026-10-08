'use client';

import { useRef } from 'react';
import { FILE_ACCEPT } from './logic';

interface AddFilesButtonProps {
  label: string;
  accessibilityLabel?: string;
  // Set to place the button in a slot of its parent, for example a section's secondary actions.
  slot?: Lowercase<string>;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
}

// A button that opens the browser's file picker. The picker is a hidden native input: a Polaris button
// cannot open one by itself.
export function AddFilesButton({ label, accessibilityLabel, slot, disabled = false, onFiles }: AddFilesButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        hidden
        multiple
        accept={FILE_ACCEPT}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          // Copy the files before resetting, so the same file can be picked again.
          const picked = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = '';
          if (picked.length > 0) onFiles(picked);
        }}
      />
      <s-button slot={slot} disabled={disabled} accessibilityLabel={accessibilityLabel} onClick={() => inputRef.current?.click()}>
        {label}
      </s-button>
    </>
  );
}
