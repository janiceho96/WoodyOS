import type { ExpressionDefinition, EyePose, EyebrowPose, MascotExpression, MouthPose } from './Types';

type EyeOverride = Partial<EyePose>;
type BrowOverride = Partial<EyebrowPose>;
type MouthOverride = Partial<MouthPose>;
type ExpressionOverride = {
  eyes?: { left?: EyeOverride; right?: EyeOverride };
  eyebrows?: { left?: BrowOverride; right?: BrowOverride };
  mouth?: MouthOverride;
  cheeks?: number;
  body?: Partial<ExpressionDefinition['body']>;
};

const baseEye: EyePose = { shape: 'rounded', x: 0, y: 0, scaleX: 1, scaleY: 1, rotate: 0, opacity: 1 };
const baseBrow: EyebrowPose = { y: 0, rotate: 0, opacity: .82 };
const baseMouth: MouthPose = { shape: 'softSmile', y: 0, scaleX: 1, scaleY: 1 };

function expression(override: ExpressionOverride = {}): ExpressionDefinition {
  return {
    eyes: {
      left: { ...baseEye, ...override.eyes?.left },
      right: { ...baseEye, ...override.eyes?.right },
    },
    eyebrows: {
      left: { ...baseBrow, ...override.eyebrows?.left },
      right: { ...baseBrow, ...override.eyebrows?.right },
    },
    mouth: { ...baseMouth, ...override.mouth },
    cheeks: override.cheeks ?? 0,
    body: { bounce: 0, tilt: 0, squash: 0, ...override.body },
  };
}

export const expressions: Readonly<Record<MascotExpression, ExpressionDefinition>> = {
  neutral: expression(),
  happy: expression({ eyes: { left: { shape: 'arc' }, right: { shape: 'arc' } }, mouth: { shape: 'smile' }, cheeks: .18, body: { bounce: 1 } }),
  veryHappy: expression({ eyes: { left: { shape: 'squint' }, right: { shape: 'squint', rotate: -8 } }, eyebrows: { left: { y: -2 }, right: { y: -2 } }, mouth: { shape: 'grin', scaleX: 1.12 }, cheeks: .35, body: { bounce: 2, squash: .015 } }),
  laughing: expression({ eyes: { left: { shape: 'closed' }, right: { shape: 'closed' } }, eyebrows: { left: { y: -3 }, right: { y: -3 } }, mouth: { shape: 'laugh', scaleX: 1.12, scaleY: 1.08 }, cheeks: .28, body: { bounce: 3, squash: .02 } }),
  excited: expression({ eyes: { left: { shape: 'star', scaleX: .9, scaleY: .9 }, right: { shape: 'star', scaleX: .9, scaleY: .9 } }, eyebrows: { left: { y: -4 }, right: { y: -4 } }, mouth: { shape: 'open' }, cheeks: .2, body: { bounce: 4, squash: .025 } }),
  curious: expression({ eyes: { left: { shape: 'circle', x: 1, y: -1 }, right: { shape: 'rounded', x: 1, y: -1, scaleY: 1.08 } }, eyebrows: { left: { y: -3, rotate: -8 }, right: { y: 1, rotate: 7 } }, mouth: { shape: 'tiny', y: 1 }, body: { tilt: 2 } }),
  thinking: expression({ eyes: { left: { shape: 'crescent', x: 2, y: -3 }, right: { shape: 'crescent', x: 2, y: -3 } }, eyebrows: { left: { y: -2, rotate: -5 }, right: { y: -1, rotate: 8 } }, mouth: { shape: 'wobble' }, body: { tilt: -2 } }),
  confused: expression({ eyes: { left: { shape: 'squint', rotate: 8 }, right: { shape: 'circle', scaleX: .86, scaleY: .86 } }, eyebrows: { left: { y: 1, rotate: 13 }, right: { y: -3, rotate: 12 } }, mouth: { shape: 'wobble' }, body: { tilt: -3 } }),
  surprised: expression({ eyes: { left: { shape: 'circle', scaleX: 1.08, scaleY: 1.08 }, right: { shape: 'circle', scaleX: 1.08, scaleY: 1.08 } }, eyebrows: { left: { y: -6 }, right: { y: -6 } }, mouth: { shape: 'o', scaleX: .9 }, body: { bounce: -1 } }),
  sleepy: expression({ eyes: { left: { shape: 'half', y: 2 }, right: { shape: 'half', y: 2 } }, eyebrows: { left: { y: 2, opacity: .55 }, right: { y: 2, opacity: .55 } }, mouth: { shape: 'tiny', y: 2 }, cheeks: .08, body: { tilt: -1, squash: .02 } }),
  worried: expression({ eyes: { left: { shape: 'circle', scaleX: .88 }, right: { shape: 'circle', scaleX: .88 } }, eyebrows: { left: { y: -2, rotate: -13 }, right: { y: -2, rotate: 13 } }, mouth: { shape: 'frown', scaleX: .82 }, cheeks: .08, body: { bounce: -1, squash: .01 } }),
  sad: expression({ eyes: { left: { shape: 'crescent', y: 2, rotate: 180 }, right: { shape: 'crescent', y: 2, rotate: 180 } }, eyebrows: { left: { rotate: -12 }, right: { rotate: 12 } }, mouth: { shape: 'frown' }, body: { bounce: -2, tilt: -1, squash: .02 } }),
  angry: expression({ eyes: { left: { shape: 'squint', rotate: -14 }, right: { shape: 'squint', rotate: 14 } }, eyebrows: { left: { y: 1, rotate: 18 }, right: { y: 1, rotate: -18 } }, mouth: { shape: 'determined' }, body: { bounce: 1, squash: .02 } }),
  determined: expression({ eyes: { left: { shape: 'line', rotate: -4 }, right: { shape: 'line', rotate: 4 } }, eyebrows: { left: { rotate: 11 }, right: { rotate: -11 } }, mouth: { shape: 'determined', scaleX: 1.08 }, body: { bounce: 1 } }),
  proud: expression({ eyes: { left: { shape: 'half', y: 1 }, right: { shape: 'half', y: 1 } }, eyebrows: { left: { y: -2 }, right: { y: -2 } }, mouth: { shape: 'softSmile', scaleX: 1.15 }, cheeks: .12, body: { bounce: 1, tilt: 1 } }),
  embarrassed: expression({ eyes: { left: { shape: 'rounded', x: -2, scaleY: .82 }, right: { shape: 'rounded', x: -2, scaleY: .82 } }, eyebrows: { left: { y: 1, rotate: -6 }, right: { y: 1, rotate: 6 } }, mouth: { shape: 'wobble', scaleX: .8 }, cheeks: .7, body: { tilt: -2, squash: .01 } }),
  love: expression({ eyes: { left: { shape: 'heart', scaleX: 1.05, scaleY: 1.05 }, right: { shape: 'heart', scaleX: 1.05, scaleY: 1.05 } }, eyebrows: { left: { opacity: 0 }, right: { opacity: 0 } }, mouth: { shape: 'heart', y: 1 }, cheeks: .55, body: { bounce: 3, squash: .02 } }),
  shy: expression({ eyes: { left: { shape: 'crescent', x: -2, y: 1 }, right: { shape: 'crescent', x: -2, y: 1 } }, eyebrows: { left: { y: 1 }, right: { y: 1 } }, mouth: { shape: 'tiny', scaleX: .8 }, cheeks: .62, body: { tilt: -3, squash: .015 } }),
  loading: expression({ eyes: { left: { shape: 'loading' }, right: { shape: 'loading' } }, eyebrows: { left: { opacity: 0 }, right: { opacity: 0 } }, mouth: { shape: 'flat', scaleX: .45 }, body: { bounce: 1 } }),
  typing: expression({ eyes: { left: { shape: 'rounded', scaleY: .9 }, right: { shape: 'rounded', scaleY: .9 } }, eyebrows: { left: { opacity: .55 }, right: { opacity: .55 } }, mouth: { shape: 'tiny', scaleX: .5 }, body: { bounce: 1 } }),
  listening: expression({ eyes: { left: { shape: 'circle', x: -1 }, right: { shape: 'circle', x: -1 } }, eyebrows: { left: { y: -2, rotate: -4 }, right: { y: -2, rotate: 4 } }, mouth: { shape: 'softSmile', scaleX: .75 }, body: { tilt: 3 } }),
  processing: expression({ eyes: { left: { shape: 'spiral', scaleX: .92, scaleY: .92 }, right: { shape: 'spiral', scaleX: .92, scaleY: .92, rotate: 180 } }, eyebrows: { left: { opacity: 0 }, right: { opacity: 0 } }, mouth: { shape: 'flat', scaleX: .55 }, body: { bounce: 1 } }),
  error: expression({ eyes: { left: { shape: 'line', rotate: 35 }, right: { shape: 'line', rotate: -35 } }, eyebrows: { left: { y: -2, rotate: 14 }, right: { y: -2, rotate: -14 } }, mouth: { shape: 'frown', scaleX: .9 }, body: { squash: .02 } }),
  offline: expression({ eyes: { left: { shape: 'closed' }, right: { shape: 'closed' } }, eyebrows: { left: { opacity: .3, y: 2 }, right: { opacity: .3, y: 2 } }, mouth: { shape: 'flat', scaleX: .7 }, body: { bounce: -2, squash: .025 } }),
  success: expression({ eyes: { left: { shape: 'arc' }, right: { shape: 'arc' } }, eyebrows: { left: { y: -3 }, right: { y: -3 } }, mouth: { shape: 'grin' }, cheeks: .24, body: { bounce: 4, squash: .03 } }),
  celebrating: expression({ eyes: { left: { shape: 'star' }, right: { shape: 'star', rotate: 18 } }, eyebrows: { left: { opacity: 0 }, right: { opacity: 0 } }, mouth: { shape: 'laugh', scaleX: 1.12 }, cheeks: .35, body: { bounce: 5, tilt: 2, squash: .035 } }),
};

export const mascotExpressionNames = Object.freeze(Object.keys(expressions) as MascotExpression[]);

export function getExpression(name: MascotExpression): ExpressionDefinition {
  return expressions[name];
}
