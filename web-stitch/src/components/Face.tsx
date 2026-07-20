import { memo } from 'react';
import { m } from 'framer-motion';
import { Eyes } from './Eyes';
import { Eyebrows } from './Eyebrows';
import { Mouth } from './Mouth';
import type { ExpressionDefinition, MascotGradientIds, MascotPalette } from './Types';

export const Face = memo(function Face({ expression, palette, gradients, blink, speaking, reducedMotion }: {
  expression: ExpressionDefinition; palette: MascotPalette; gradients: MascotGradientIds; blink: boolean; speaking: boolean; reducedMotion: boolean;
}) {
  return <g id="woody-face" data-part="face">
    <g id="woody-face-panel" data-part="face-panel">
      <rect x={58} y={62} width={124} height={88} rx={32} fill={`url(#${gradients.face})`} stroke={palette.faceShadow} strokeWidth={1.5}/>
      <path d="M 71 77 Q 120 57 169 77" fill="none" stroke="#fff" strokeOpacity={.68} strokeWidth={2.2} strokeLinecap="round"/>
    </g>
    <Eyebrows left={expression.eyebrows.left} right={expression.eyebrows.right} palette={palette}/>
    <Eyes left={expression.eyes.left} right={expression.eyes.right} palette={palette} blink={blink} reducedMotion={reducedMotion}/>
    <Mouth pose={expression.mouth} palette={palette} speaking={speaking} reducedMotion={reducedMotion}/>
    <m.g id="woody-cheeks" data-part="cheeks" initial={false} animate={{ opacity: expression.cheeks }} transition={{ duration: .24 }}>
      <ellipse cx={76} cy={123} rx={10} ry={5} fill={palette.cheek}/>
      <ellipse cx={164} cy={123} rx={10} ry={5} fill={palette.cheek}/>
    </m.g>
  </g>;
});
