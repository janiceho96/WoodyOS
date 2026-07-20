import type { MascotPalette, MascotSkin } from './Types';

export const mascotPalettes: Record<MascotSkin, MascotPalette> = {
  classic: {
    purpleBack: '#4b27c8', purpleMiddle: '#7145e8', purpleFront: '#9b6cff', purpleLight: '#c6a9ff',
    face: '#fffefe', faceShadow: '#e9e5f3', ink: '#101f52', body: '#8a59ef', bodyLight: '#bd9aff',
    joint: '#4528a5', accent: '#3de1ff', cheek: '#ff93c9', outline: '#34207f',
  },
  midnight: {
    purpleBack: '#181844', purpleMiddle: '#29275f', purpleFront: '#454284', purpleLight: '#7772c5',
    face: '#f3f5ff', faceShadow: '#cfd4eb', ink: '#09112d', body: '#34316f', bodyLight: '#625da5',
    joint: '#141339', accent: '#64e9ff', cheek: '#e28dc9', outline: '#0c0b29',
  },
  rose: {
    purpleBack: '#7d286e', purpleMiddle: '#ad438d', purpleFront: '#db71b5', purpleLight: '#f4b2dd',
    face: '#fffafd', faceShadow: '#f2dce9', ink: '#421438', body: '#c25aa2', bodyLight: '#e99dcd',
    joint: '#71245f', accent: '#ffd26a', cheek: '#ff8eb8', outline: '#571a4a',
  },
};

export function resolveMascotPalette(skin: MascotSkin, colors?: Partial<MascotPalette>): MascotPalette {
  return { ...mascotPalettes[skin], ...colors };
}
