import { memo, type ReactNode } from 'react';
import { m } from 'framer-motion';
import { headAnimation } from './Animations';
import { Face } from './Face';
import type { ExpressionDefinition, MascotExpression, MascotGradientIds, MascotPalette } from './Types';

export const Head = memo(function Head({ expressionName, expression, palette, gradients, blink, speaking, thinking, reducedMotion, headAccessory, faceAccessory }: {
  expressionName: MascotExpression;
  expression: ExpressionDefinition;
  palette: MascotPalette;
  gradients: MascotGradientIds;
  blink: boolean;
  speaking: boolean;
  thinking: boolean;
  reducedMotion: boolean;
  headAccessory?: ReactNode;
  faceAccessory?: ReactNode;
}) {
  return <m.g
    id="woody-head"
    data-part="head"
    initial={false}
    animate={headAnimation(expressionName, thinking, reducedMotion)}
    style={{ transformOrigin: '120px 155px', transformBox: 'view-box' }}
  >
    <g id="woody-head-back-layer" data-part="head-back-layer">
      <path d="M 48 40 H 192 Q 212 40 212 61 V 137 Q 212 159 190 159 H 182 L 191 176 Q 194 182 188 185 Q 183 188 178 182 L 159 163 H 48 Q 28 163 28 143 V 61 Q 28 40 48 40 Z" fill={`url(#${gradients.headBack})`} stroke={palette.outline} strokeWidth={1.4}/>
    </g>
    <g id="woody-head-middle-layer" data-part="head-middle-layer">
      <path d="M 51 46 H 189 Q 205 46 205 63 V 133 Q 205 151 187 151 H 177 L 185 168 Q 188 174 183 177 Q 178 180 173 174 L 156 156 H 51 Q 35 156 35 139 V 63 Q 35 46 51 46 Z" fill={`url(#${gradients.headMiddle})`} stroke={palette.purpleLight} strokeOpacity={.42} strokeWidth={1.2}/>
    </g>
    <g id="woody-head-front-layer" data-part="head-front-layer">
      <path d="M 54 52 H 186 Q 199 52 199 66 V 130 Q 199 144 184 144 H 171 L 179 159 Q 182 165 177 168 Q 172 170 168 165 L 153 150 H 54 Q 41 150 41 136 V 66 Q 41 52 54 52 Z" fill={`url(#${gradients.headFront})`} stroke={palette.purpleLight} strokeOpacity={.72} strokeWidth={1.2}/>
      <path d="M 58 59 Q 118 42 181 59" fill="none" stroke="#fff" strokeOpacity={.28} strokeWidth={2.2} strokeLinecap="round"/>
    </g>
    <Face expression={expression} palette={palette} gradients={gradients} blink={blink} speaking={speaking} reducedMotion={reducedMotion}/>
    {faceAccessory && <g id="woody-face-accessory" data-slot="face">{faceAccessory}</g>}
    {headAccessory && <g id="woody-head-accessory" data-slot="head">{headAccessory}</g>}
  </m.g>;
});
