import { memo } from 'react';

export const BrandMark = memo(function BrandMark({ className = '' }: { className?: string }) {
  return <span className={`nexus-mark ${className}`.trim()} aria-hidden="true">
    <img src="/woody-logo.png" alt=""/>
  </span>;
});
