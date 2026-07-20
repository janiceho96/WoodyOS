import { memo } from 'react';
import { m } from 'framer-motion';
import { faceTransition } from './Animations';
import type { EyebrowPose, MascotPalette } from './Types';

const Eyebrow = memo(function Eyebrow({ side, cx, pose, palette }: { side: 'left' | 'right'; cx: number; pose: EyebrowPose; palette: MascotPalette }) {
  return <m.g
    id={`woody-${side}-eyebrow`}
    data-part={`${side}-eyebrow`}
    initial={false}
    animate={{ y: pose.y, rotate: pose.rotate, opacity: pose.opacity }}
    transition={faceTransition}
    style={{ transformOrigin: `${cx}px 78px`, transformBox: 'view-box' }}
  >
    <path d={`M ${cx - 9} 78 Q ${cx} 73 ${cx + 9} 78`} fill="none" stroke={palette.ink} strokeWidth={3.4} strokeLinecap="round" vectorEffect="non-scaling-stroke"/>
  </m.g>;
});

export const Eyebrows = memo(function Eyebrows({ left, right, palette }: { left: EyebrowPose; right: EyebrowPose; palette: MascotPalette }) {
  return <g id="woody-eyebrows" data-part="eyebrows">
    <Eyebrow side="left" cx={91} pose={left} palette={palette}/>
    <Eyebrow side="right" cx={149} pose={right} palette={palette}/>
  </g>;
});
