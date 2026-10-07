import { useEffect, useRef, type HTMLAttributes } from 'react';

/** Reveal an explicit new step without submitting it or moving keyboard focus. */
export function RevealStep({ children, ...props }: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest' });
  }, []);
  return (
    <div {...props} ref={ref} style={{ scrollMarginTop: 120, ...props.style }}>
      {children}
    </div>
  );
}
