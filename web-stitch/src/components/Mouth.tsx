import { memo } from 'react';
import { m } from 'framer-motion';
import { faceTransition } from './Animations';
import type { MascotPalette, MouthPose, MouthShape } from './Types';

const mouthPaths: Record<MouthShape, string> = {
  softSmile: 'M 107 122 C 113 126 127 126 133 122',
  smile: 'M 104 120 C 111 132 129 132 136 120',
  grin: 'M 103 119 C 110 134 130 134 137 119',
  open: 'M 108 120 C 114 124 126 124 132 120',
  laugh: 'M 104 118 C 111 127 129 127 136 118',
  flat: 'M 108 124 C 115 124 125 124 132 124',
  o: 'M 113 123 C 116 120 124 120 127 123',
  frown: 'M 106 129 C 113 120 127 120 134 129',
  wobble: 'M 106 125 C 112 120 117 130 122 125 C 127 120 131 126 134 124',
  determined: 'M 106 126 C 114 124 126 124 134 126',
  tiny: 'M 115 124 C 118 126 122 126 125 124',
  heart: 'M 114 122 C 116 117 120 120 120 122 C 120 120 124 117 126 122',
};

export const Mouth = memo(function Mouth({ pose, palette, speaking, reducedMotion }: { pose: MouthPose; palette: MascotPalette; speaking: boolean; reducedMotion: boolean }) {
  const isOpen = pose.shape === 'open' || pose.shape === 'laugh' || pose.shape === 'o';
  const isHeart = pose.shape === 'heart';
  const openSize = pose.shape === 'laugh' ? { rx: 13, ry: 9 } : pose.shape === 'o' ? { rx: 6, ry: 7 } : { rx: 10, ry: 7 };
  return <m.g
    id="woody-mouth"
    data-part="mouth"
    initial={false}
    animate={{ y: pose.y, scaleX: pose.scaleX, scaleY: pose.scaleY }}
    transition={faceTransition}
    style={{ transformOrigin: '120px 124px', transformBox: 'view-box' }}
  >
    <m.g
      animate={speaking && !reducedMotion ? { scaleY: [1, .55, 1.18, .72, 1] } : { scaleY: 1 }}
      transition={speaking && !reducedMotion ? { duration: .62, repeat: Infinity, ease: 'easeInOut' } : faceTransition}
      style={{ transformOrigin: '120px 124px', transformBox: 'view-box' }}
    >
      <m.ellipse
        cx={120} cy={124} fill={palette.ink}
        initial={false}
        animate={{ rx: isOpen ? openSize.rx : 2, ry: isOpen ? openSize.ry : 1, opacity: isOpen ? 1 : 0 }}
        transition={faceTransition}
      />
      <m.path
        d={mouthPaths[pose.shape]}
        fill={isHeart ? palette.ink : 'none'}
        stroke={isHeart || isOpen ? 'none' : palette.ink}
        strokeWidth={3.2}
        strokeLinecap="round"
        initial={false}
        animate={{ d: mouthPaths[pose.shape], opacity: isOpen ? 0 : 1 }}
        transition={faceTransition}
        vectorEffect="non-scaling-stroke"
      />
      <m.path d="M 112 122 Q 120 127 128 122" fill="none" stroke="#fff" strokeWidth={2.4} strokeLinecap="round" initial={false} animate={{ opacity: pose.shape === 'grin' ? .95 : 0 }} transition={faceTransition}/>
    </m.g>
  </m.g>;
});
