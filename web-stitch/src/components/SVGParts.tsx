import { memo, type ReactNode } from 'react';
import { m, type TargetAndTransition } from 'framer-motion';
import { antennaAnimation, waveAnimation } from './Animations';
import type { MascotGradientIds, MascotPalette } from './Types';

export const MascotDefs = memo(function MascotDefs({ ids, palette }: { ids: MascotGradientIds; palette: MascotPalette }) {
  return <defs>
    <linearGradient id={ids.headBack} x1="0" y1="0" x2="1" y2="1"><stop stopColor={palette.purpleMiddle}/><stop offset="1" stopColor={palette.purpleBack}/></linearGradient>
    <linearGradient id={ids.headMiddle} x1=".12" y1="0" x2=".9" y2="1"><stop stopColor={palette.purpleLight}/><stop offset=".5" stopColor={palette.purpleMiddle}/><stop offset="1" stopColor={palette.purpleBack}/></linearGradient>
    <linearGradient id={ids.headFront} x1=".18" y1="0" x2=".84" y2="1"><stop stopColor={palette.purpleLight}/><stop offset=".48" stopColor={palette.purpleFront}/><stop offset="1" stopColor={palette.purpleMiddle}/></linearGradient>
    <linearGradient id={ids.face} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#ffffff"/><stop offset=".72" stopColor={palette.face}/><stop offset="1" stopColor={palette.faceShadow}/></linearGradient>
    <linearGradient id={ids.body} x1=".15" y1="0" x2=".86" y2="1"><stop stopColor={palette.bodyLight}/><stop offset=".55" stopColor={palette.body}/><stop offset="1" stopColor={palette.purpleMiddle}/></linearGradient>
    <linearGradient id={ids.limb} x1="0" y1="0" x2="1" y2="1"><stop stopColor={palette.purpleLight}/><stop offset="1" stopColor={palette.body}/></linearGradient>
    <radialGradient id={ids.glow}><stop stopColor="#fff"/><stop offset=".3" stopColor={palette.accent}/><stop offset="1" stopColor={palette.purpleMiddle}/></radialGradient>
    <filter id={ids.shadow} x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="4" stdDeviation="4" floodColor={palette.outline} floodOpacity=".24"/></filter>
  </defs>;
});

export const Antenna = memo(function Antenna({ palette, gradients, thinking, reducedMotion, accessory }: { palette: MascotPalette; gradients: MascotGradientIds; thinking: boolean; reducedMotion: boolean; accessory?: ReactNode }) {
  return <m.g
    id="woody-antenna" data-part="antenna" initial={false}
    animate={antennaAnimation(thinking, reducedMotion)}
    style={{ transformOrigin: '120px 45px', transformBox: 'view-box' }}
  >
    <rect x={115} y={22} width={10} height={25} rx={5} fill={`url(#${gradients.headMiddle})`}/>
    <circle cx={120} cy={16} r={12} fill={`url(#${gradients.headFront})`} stroke={palette.purpleLight} strokeWidth={1.2}/>
    <circle cx={116} cy={12} r={3.2} fill="#fff" opacity={.3}/>
    {accessory && <g id="woody-antenna-accessory" data-slot="antenna">{accessory}</g>}
  </m.g>;
});

type MovingPartProps = { palette: MascotPalette; gradients: MascotGradientIds; motionState: TargetAndTransition };

export const Body = memo(function Body({ palette, gradients, motionState, accessory }: MovingPartProps & { accessory?: ReactNode }) {
  return <m.g id="woody-body" data-part="body" initial={false} animate={motionState} style={{ transformOrigin: '120px 218px', transformBox: 'view-box' }}>
    <rect x={110} y={157} width={20} height={20} rx={8} fill={palette.joint}/>
    <path d="M 87 174 Q 120 163 153 174 Q 169 184 167 215 Q 165 239 145 248 Q 120 258 95 248 Q 75 239 73 215 Q 71 184 87 174 Z" fill={`url(#${gradients.body})`} stroke={palette.outline} strokeWidth={1.4} filter={`url(#${gradients.shadow})`}/>
    <path d="M 91 223 Q 120 239 149 223 Q 145 244 120 248 Q 95 244 91 223 Z" fill={palette.face} opacity={.55}/>
    <path d="M 90 181 Q 120 169 150 181" fill="none" stroke="#fff" strokeOpacity={.32} strokeWidth={2.2} strokeLinecap="round"/>
    <circle cx={146} cy={204} r={9} fill={palette.joint} opacity={.65}/>
    <circle cx={146} cy={204} r={6.2} fill={`url(#${gradients.glow})`}/>
    {accessory && <g id="woody-body-accessory" data-slot="body">{accessory}</g>}
  </m.g>;
});

export const LeftArm = memo(function LeftArm({ palette, gradients, motionState }: MovingPartProps) {
  return <m.g id="woody-left-arm" data-part="left-arm" initial={false} animate={motionState} style={{ transformOrigin: '76px 187px', transformBox: 'view-box' }}>
    <circle cx={76} cy={188} r={10} fill={palette.joint}/>
    <path d="M 69 183 Q 59 183 52 194 L 39 213 Q 35 220 42 225 Q 49 230 54 223 L 70 205 Q 80 194 76 187 Z" fill={`url(#${gradients.limb})`} stroke={palette.outline} strokeWidth={1.2}/>
    <path d="M 52 194 Q 59 188 67 190" fill="none" stroke="#fff" strokeOpacity={.3} strokeWidth={1.8} strokeLinecap="round"/>
  </m.g>;
});

export const RightArm = memo(function RightArm({ palette, gradients, motionState, waving, reducedMotion }: MovingPartProps & { waving: boolean; reducedMotion: boolean }) {
  return <m.g id="woody-right-arm" data-part="right-arm" initial={false} animate={motionState} style={{ transformOrigin: '164px 187px', transformBox: 'view-box' }}>
    <m.g initial={false} animate={waveAnimation(waving, reducedMotion)} style={{ transformOrigin: '164px 187px', transformBox: 'view-box' }}>
      <circle cx={164} cy={188} r={10} fill={palette.joint}/>
      <path d="M 171 183 Q 181 183 188 194 L 201 213 Q 205 220 198 225 Q 191 230 186 223 L 170 205 Q 160 194 164 187 Z" fill={`url(#${gradients.limb})`} stroke={palette.outline} strokeWidth={1.2}/>
      <path d="M 188 194 Q 181 188 173 190" fill="none" stroke="#fff" strokeOpacity={.3} strokeWidth={1.8} strokeLinecap="round"/>
    </m.g>
  </m.g>;
});

export const LeftHand = memo(function LeftHand({ palette, gradients, motionState }: MovingPartProps) {
  return <m.g id="woody-left-hand" data-part="left-hand" initial={false} animate={motionState} style={{ transformOrigin: '40px 224px', transformBox: 'view-box' }}>
    <path d="M 42 211 Q 30 209 25 219 Q 20 230 28 239 Q 37 248 48 241 Q 56 236 53 225 Q 51 216 42 211 Z" fill={`url(#${gradients.limb})`} stroke={palette.outline} strokeWidth={1.2}/>
  </m.g>;
});

export const RightHand = memo(function RightHand({ palette, gradients, motionState, waving, reducedMotion }: MovingPartProps & { waving: boolean; reducedMotion: boolean }) {
  return <m.g id="woody-right-hand" data-part="right-hand" initial={false} animate={motionState} style={{ transformOrigin: '164px 187px', transformBox: 'view-box' }}>
    <m.g initial={false} animate={waveAnimation(waving, reducedMotion)} style={{ transformOrigin: '164px 187px', transformBox: 'view-box' }}>
      <path d="M 198 211 Q 210 209 215 219 Q 220 230 212 239 Q 203 248 192 241 Q 184 236 187 225 Q 189 216 198 211 Z" fill={`url(#${gradients.limb})`} stroke={palette.outline} strokeWidth={1.2}/>
    </m.g>
  </m.g>;
});

export const LeftLeg = memo(function LeftLeg({ palette, gradients, motionState }: MovingPartProps) {
  return <m.g id="woody-left-leg" data-part="left-leg" initial={false} animate={motionState} style={{ transformOrigin: '102px 244px', transformBox: 'view-box' }}>
    <rect x={92} y={240} width={20} height={31} rx={9} fill={palette.joint} stroke={palette.outline} strokeWidth={1.1}/>
    <path d="M 81 269 Q 84 258 98 257 H 106 Q 116 258 117 270 V 278 Q 116 284 108 285 H 83 Q 76 284 77 278 Z" fill={`url(#${gradients.limb})`} stroke={palette.outline} strokeWidth={1.3}/>
    <path d="M 80 277 Q 98 282 115 277" fill="none" stroke={palette.face} strokeOpacity={.75} strokeWidth={3}/>
  </m.g>;
});

export const RightLeg = memo(function RightLeg({ palette, gradients, motionState }: MovingPartProps) {
  return <m.g id="woody-right-leg" data-part="right-leg" initial={false} animate={motionState} style={{ transformOrigin: '138px 244px', transformBox: 'view-box' }}>
    <rect x={128} y={240} width={20} height={31} rx={9} fill={palette.joint} stroke={palette.outline} strokeWidth={1.1}/>
    <path d="M 123 270 Q 124 258 134 257 H 142 Q 156 258 159 269 L 163 278 Q 164 284 157 285 H 132 Q 124 284 123 278 Z" fill={`url(#${gradients.limb})`} stroke={palette.outline} strokeWidth={1.3}/>
    <path d="M 125 277 Q 142 282 160 277" fill="none" stroke={palette.face} strokeOpacity={.75} strokeWidth={3}/>
  </m.g>;
});
