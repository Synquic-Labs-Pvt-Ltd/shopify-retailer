import { useEffect, useRef, type RefObject } from 'react';

export type ModalElement = HTMLElementTagNameMap['s-modal'];

// Opens and closes an s-modal from React state. The modal also closes by itself (Escape, the backdrop, a button
// with command="--hide"), and reports that through its `hide` event. React 19 only maps names it knows to
// `onXxx` props, so the `hide` listener is attached by hand.
export function useModalOverlay(ref: RefObject<ModalElement | null>, open: boolean, onHide: () => void): void {
  const onHideRef = useRef(onHide);
  const shown = useRef(false);

  useEffect(() => {
    onHideRef.current = onHide;
  });

  useEffect(() => {
    const modal = ref.current;
    if (modal === null) return;
    const handleHide = () => {
      shown.current = false;
      onHideRef.current();
    };
    modal.addEventListener('hide', handleHide);
    return () => modal.removeEventListener('hide', handleHide);
  }, [ref]);

  useEffect(() => {
    const modal = ref.current;
    if (modal === null) return;
    if (open && !shown.current && typeof modal.showOverlay === 'function') {
      shown.current = true;
      modal.showOverlay();
    } else if (!open && shown.current && typeof modal.hideOverlay === 'function') {
      shown.current = false;
      modal.hideOverlay();
    }
  }, [open, ref]);
}
