import { memo } from 'react';
import { m } from 'framer-motion';
import { faceTransition } from './Animations';
import type { EyePose, MascotPalette } from './Types';

type Point = readonly [number, number];

function smoothClosedPath(points: readonly Point[]) {
  const count = points.length;
  let path = `M ${points[0][0]} ${points[0][1]}`;
  for (let index = 0; index < count; index += 1) {
    const previous = points[(index - 1 + count) % count];
    const current = points[index];
    const next = points[(index + 1) % count];
    const after = points[(index + 2) % count];
    const c1x = current[0] + (next[0] - previous[0]) / 6;
    const c1y = current[1] + (next[1] - previous[1]) / 6;
    const c2x = next[0] - (after[0] - current[0]) / 6;
    const c2y = next[1] - (after[1] - current[1]) / 6;
    path += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${next[0]} ${next[1]}`;
  }
  return `${path} Z`;
}

const eyePoints = {
  rounded: [[-7,-10],[-3,-11],[3,-11],[7,-9],[8,-4],[8,4],[7,9],[3,11],[-3,11],[-7,9],[-8,4],[-8,-4]],
  circle: [[0,-10],[5,-9],[9,-5],[10,0],[9,5],[5,9],[0,10],[-5,9],[-9,5],[-10,0],[-9,-5],[-5,-9]],
  line: [[-10,-1.5],[-6,-2],[0,-2],[6,-2],[10,-1.5],[10,0],[10,1.5],[6,2],[0,2],[-6,2],[-10,1.5],[-10,0]],
  arc: [[-10,2],[-8,-1],[-5,-4],[0,-6],[5,-4],[8,-1],[10,2],[7,1],[4,-1],[0,-2],[-4,-1],[-7,1]],
  crescent: [[-2,-10],[4,-9],[8,-5],[9,0],[7,6],[2,9],[-4,9],[-1,6],[1,2],[1,-2],[-1,-6],[-4,-9]],
  half: [[-10,2],[-9,-2],[-6,-6],[0,-8],[6,-6],[9,-2],[10,2],[6,3],[2,4],[-2,4],[-6,3],[-9,2]],
  squint: [[-10,4],[-8,0],[-5,-3],[0,-5],[5,-3],[8,0],[10,4],[6,3],[3,1],[0,0],[-3,1],[-6,3]],
  star: [[0,-11],[3,-4],[9,-6],[5,0],[10,5],[3,4],[0,11],[-3,4],[-10,5],[-5,0],[-9,-6],[-3,-4]],
  spiral: [[9,0],[6,5],[1,8],[-5,6],[-8,1],[-6,-5],[-1,-7],[4,-5],[6,-1],[4,3],[0,4],[-2,1]],
  loading: [[-9,-1],[-6,-2],[0,-2],[6,-2],[9,-1],[9,0],[9,1],[6,2],[0,2],[-6,2],[-9,1],[-9,0]],
  heart: [[0,10],[-4,6],[-8,2],[-9,-3],[-7,-7],[-3,-8],[0,-5],[3,-8],[7,-7],[9,-3],[8,2],[4,6]],
  diamond: [[0,-11],[3,-7],[7,-3],[10,0],[7,3],[3,7],[0,11],[-3,7],[-7,3],[-10,0],[-7,-3],[-3,-7]],
  closed: [[-10,0],[-7,-2],[-3,-3],[0,-3],[3,-3],[7,-2],[10,0],[7,1],[3,2],[0,2],[-3,2],[-7,1]],
} as const satisfies Record<EyePose['shape'], readonly Point[]>;

const eyePaths = Object.fromEntries(Object.entries(eyePoints).map(([shape, points]) => [shape, smoothClosedPath(points)])) as Record<EyePose['shape'], string>;

const Eye = memo(function Eye({ side, cx, pose, palette, blink, reducedMotion }: {
  side: 'left' | 'right'; cx: number; pose: EyePose; palette: MascotPalette; blink: boolean; reducedMotion: boolean;
}) {
  const canBlink = blink && !reducedMotion && !['line', 'arc', 'half', 'squint', 'loading', 'closed', 'star', 'heart'].includes(pose.shape);
  const isSpiral = pose.shape === 'spiral';
  return <m.g
    id={`woody-${side}-eye`}
    data-part={`${side}-eye`}
    initial={false}
    animate={{ x: pose.x, y: pose.y, rotate: pose.rotate, scaleX: pose.scaleX, scaleY: pose.scaleY, opacity: pose.opacity }}
    transition={faceTransition}
    style={{ transformOrigin: `${cx}px 100px`, transformBox: 'view-box' }}
  >
    <m.g
      animate={canBlink ? { scaleY: [1, 1, .06, 1, 1] } : { scaleY: 1 }}
      transition={canBlink ? { duration: 5.2, repeat: Infinity, times: [0, .86, .89, .93, 1], delay: side === 'right' ? .025 : 0 } : faceTransition}
      style={{ transformOrigin: `${cx}px 100px`, transformBox: 'view-box' }}
    >
      <m.path
        d={eyePaths[pose.shape]}
        fill={palette.ink}
        initial={false}
        animate={{
          d: eyePaths[pose.shape],
          opacity: pose.shape === 'loading' ? 0 : 1,
          rotate: isSpiral && !reducedMotion ? [0, 360] : 0,
        }}
        transition={isSpiral && !reducedMotion ? { d: faceTransition, rotate: { duration: 2.4, repeat: Infinity, ease: 'linear' } } : faceTransition}
        transform={`translate(${cx} 100)`}
        style={{ transformOrigin: `${cx}px 100px`, transformBox: 'view-box' }}
      />
    </m.g>
  </m.g>;
});

export const Eyes = memo(function Eyes({ left, right, palette, blink, reducedMotion }: {
  left: EyePose; right: EyePose; palette: MascotPalette; blink: boolean; reducedMotion: boolean;
}) {
  const loading = left.shape === 'loading' || right.shape === 'loading';
  return <g id="woody-eyes" data-part="eyes">
    <Eye side="left" cx={91} pose={left} palette={palette} blink={blink} reducedMotion={reducedMotion}/>
    <Eye side="right" cx={149} pose={right} palette={palette} blink={blink} reducedMotion={reducedMotion}/>
    <m.g id="woody-loading-eyes" initial={false} animate={{ opacity: loading ? 1 : 0 }} transition={faceTransition}>
      {[110, 120, 130].map((cx, index) => <m.circle
        key={cx} cx={cx} cy={100} r={3.6} fill={palette.ink}
        animate={loading && !reducedMotion ? { scale: [.68, 1.16, .68], opacity: [.45, 1, .45] } : { scale: 1, opacity: 1 }}
        transition={loading && !reducedMotion ? { duration: 1.05, repeat: Infinity, delay: index * .14, ease: 'easeInOut' } : faceTransition}
        style={{ transformOrigin: `${cx}px 100px`, transformBox: 'view-box' }}
      />)}
    </m.g>
  </g>;
});
