import styles from './generations.module.css';

// A grey bar for loading states. Decorative: pair it with a visually hidden label.
export function SkeletonBar({ width }: { width: number | string }) {
  return <span className={styles.skeleton} style={{ width }} aria-hidden="true" />;
}

export function ScreenReaderText({ children }: { children: string }) {
  return <span className={styles.srOnly}>{children}</span>;
}
