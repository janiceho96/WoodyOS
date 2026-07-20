import type { CSSProperties, ReactNode } from 'react';

export type MascotExpression =
  | 'neutral' | 'happy' | 'veryHappy' | 'laughing' | 'excited' | 'curious'
  | 'thinking' | 'confused' | 'surprised' | 'sleepy' | 'worried' | 'sad'
  | 'angry' | 'determined' | 'proud' | 'embarrassed' | 'love' | 'shy'
  | 'loading' | 'typing' | 'listening' | 'processing' | 'error' | 'offline'
  | 'success' | 'celebrating';

export type EyeShape =
  | 'rounded' | 'circle' | 'line' | 'arc' | 'crescent' | 'half'
  | 'squint' | 'star' | 'spiral' | 'loading' | 'heart' | 'diamond' | 'closed';

export type MouthShape =
  | 'softSmile' | 'smile' | 'grin' | 'open' | 'laugh' | 'flat'
  | 'o' | 'frown' | 'wobble' | 'determined' | 'tiny' | 'heart';

export interface EyePose {
  shape: EyeShape;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotate: number;
  opacity: number;
}

export interface EyebrowPose {
  y: number;
  rotate: number;
  opacity: number;
}

export interface MouthPose {
  shape: MouthShape;
  y: number;
  scaleX: number;
  scaleY: number;
}

export interface ExpressionDefinition {
  eyes: { left: EyePose; right: EyePose };
  eyebrows: { left: EyebrowPose; right: EyebrowPose };
  mouth: MouthPose;
  cheeks: number;
  body: { bounce: number; tilt: number; squash: number };
}

export interface MascotPalette {
  purpleBack: string;
  purpleMiddle: string;
  purpleFront: string;
  purpleLight: string;
  face: string;
  faceShadow: string;
  ink: string;
  body: string;
  bodyLight: string;
  joint: string;
  accent: string;
  cheek: string;
  outline: string;
}

export type MascotSkin = 'classic' | 'midnight' | 'rose';
export type MascotAccessorySlot = 'antenna' | 'head' | 'face' | 'body' | 'foreground';

export interface MascotProps {
  expression?: MascotExpression;
  size?: number | string;
  speaking?: boolean;
  thinking?: boolean;
  loading?: boolean;
  waving?: boolean;
  floating?: boolean;
  blink?: boolean;
  skin?: MascotSkin;
  colors?: Partial<MascotPalette>;
  accessories?: Partial<Record<MascotAccessorySlot, ReactNode>>;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
  decorative?: boolean;
  testId?: string;
}

export interface MascotGradientIds {
  headBack: string;
  headMiddle: string;
  headFront: string;
  face: string;
  body: string;
  limb: string;
  glow: string;
  shadow: string;
}
