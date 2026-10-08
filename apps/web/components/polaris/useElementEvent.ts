import { useEffect, useRef, type RefObject } from 'react';

// A native listener on a Polaris custom element. React 19 routes only click, input and change through props:
// any other `onFoo` prop on a custom element listens for an event named exactly "Foo", while Polaris events are
// lowercase (`dismiss`, `droprejected`). A native listener also works whether or not the event bubbles.
export function useElementEvent<T extends HTMLElement>(
  ref: RefObject<T | null>,
  type: string,
  handler: (element: T, event: Event) => void,
): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });

  useEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    const listener = (event: Event): void => latest.current(element, event);
    element.addEventListener(type, listener);
    return () => element.removeEventListener(type, listener);
  }, [ref, type]);
}
