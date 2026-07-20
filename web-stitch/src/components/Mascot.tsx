import { memo, useId, useMemo } from 'react';
import { LazyMotion, MotionConfig, m, useReducedMotion } from 'framer-motion';
import { bodyAnimation, robotAnimation } from './Animations';
import { resolveMascotPalette } from './Colors';
import { getExpression } from './Expressions';
import { Head } from './Head';
import { Antenna, Body, LeftArm, LeftHand, LeftLeg, MascotDefs, RightArm, RightHand, RightLeg } from './SVGParts';
import type { MascotExpression, MascotGradientIds, MascotProps } from './Types';

function safeId(value: string) {
  return value.replaceAll(':', '').replaceAll('_', '-');
}

const loadMotionFeatures = () => import('framer-motion').then((module) => module.domAnimation);

function activeExpression(expression: MascotExpression, thinking: boolean, loading: boolean): MascotExpression {
  if (loading) return 'loading';
  if (thinking) return 'thinking';
  return expression;
}

function MascotComponent({
  expression = 'neutral', size = 240, speaking = false, thinking = false, loading = false,
  waving = false, floating = true, blink = true, skin = 'classic', colors, accessories,
  className, style, ariaLabel = 'Woody AI assistant', decorative = false, testId,
}: MascotProps) {
  const generatedId = safeId(useId());
  const reduceMotion = Boolean(useReducedMotion());
  const currentExpression = activeExpression(expression, thinking, loading);
  const definition = getExpression(currentExpression);
  const palette = useMemo(() => resolveMascotPalette(skin, colors), [skin, colors]);
  const gradients = useMemo<MascotGradientIds>(() => ({
    headBack: `${generatedId}-head-back`, headMiddle: `${generatedId}-head-middle`, headFront: `${generatedId}-head-front`,
    face: `${generatedId}-face`, body: `${generatedId}-body`, limb: `${generatedId}-limb`, glow: `${generatedId}-glow`, shadow: `${generatedId}-shadow`,
  }), [generatedId]);
  const bodyMotion = bodyAnimation(definition, speaking, reduceMotion);

  return <LazyMotion features={loadMotionFeatures} strict><MotionConfig reducedMotion="user">
    <m.svg
      className={className}
      style={{ display: 'block', overflow: 'visible', ...style }}
      width={size}
      height={size}
      viewBox="0 0 240 300"
      preserveAspectRatio="xMidYMid meet"
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : ariaLabel}
      focusable="false"
      data-testid={testId}
      data-expression={currentExpression}
      shapeRendering="geometricPrecision"
    >
      {!decorative && <title>{ariaLabel}</title>}
      <MascotDefs ids={gradients} palette={palette}/>
      <m.g
        id="woody-robot"
        data-part="robot"
        initial={false}
        animate={robotAnimation(currentExpression, floating, reduceMotion)}
        style={{ transformOrigin: '120px 165px', transformBox: 'view-box' }}
      >
        <Antenna palette={palette} gradients={gradients} thinking={thinking || currentExpression === 'processing'} reducedMotion={reduceMotion} accessory={accessories?.antenna}/>
        <Head expressionName={currentExpression} expression={definition} palette={palette} gradients={gradients} blink={blink} speaking={speaking} thinking={thinking} reducedMotion={reduceMotion} headAccessory={accessories?.head} faceAccessory={accessories?.face}/>
        <Body palette={palette} gradients={gradients} motionState={bodyMotion} accessory={accessories?.body}/>
        <LeftArm palette={palette} gradients={gradients} motionState={bodyMotion}/>
        <RightArm palette={palette} gradients={gradients} motionState={bodyMotion} waving={waving} reducedMotion={reduceMotion}/>
        <LeftHand palette={palette} gradients={gradients} motionState={bodyMotion}/>
        <RightHand palette={palette} gradients={gradients} motionState={bodyMotion} waving={waving} reducedMotion={reduceMotion}/>
        <LeftLeg palette={palette} gradients={gradients} motionState={bodyMotion}/>
        <RightLeg palette={palette} gradients={gradients} motionState={bodyMotion}/>
        {accessories?.foreground && <g id="woody-foreground-accessory" data-slot="foreground">{accessories.foreground}</g>}
      </m.g>
    </m.svg>
  </MotionConfig></LazyMotion>;
}

export const Mascot = memo(MascotComponent);
export default Mascot;

export type { MascotProps, MascotExpression } from './Types';
