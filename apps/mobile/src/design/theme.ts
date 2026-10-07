import type { ViewStyle } from 'react-native';

// Design tokens: SPEC sections 17.1 to 17.5. Light theme only, no gradients.

// 17.1 Color
export const colors = {
  canvas: '#E7E7E5',
  surface: '#FFFFFF',
  ink: '#0A0A0A',
  inkMuted: '#ABABA9',
  meta: '#77776F',
  cardGray: '#C6C6C4',
  cardGrayGraphic: '#8A8A88',
  accent: '#0A0A0A',
  accentInk: '#FFFFFF',
  accentSub: 'rgba(255,255,255,0.62)',
  onDarkMuted: 'rgba(255,255,255,0.62)',
  danger: '#E5484D',
  success: '#30A46C',
  warning: '#B8860B',
  scrim: 'rgba(10,10,10,0.55)',
  hairline: 'rgba(10,10,10,0.08)',
  tintNeutral: 'rgba(10,10,10,0.06)',
  tintPending: 'rgba(10,10,10,0.06)',
  tintSuccess: 'rgba(48,163,108,0.14)',
  tintDanger: 'rgba(229,72,77,0.12)',
  tintWarning: 'rgba(200,140,0,0.14)',
  selectedTileDim: 'rgba(231,231,229,0.55)',
  viewerBackground: '#000000',
  imagePreviewBackground: 'rgba(0,0,0,0.92)',
  viewerControl: 'rgba(0,0,0,0.35)',
} as const;
export type ColorName = keyof typeof colors;

// 17.2 Typography (Inter, six weights)
export const fontFamily = {
  black: 'Inter_900Black',
  extraBold: 'Inter_800ExtraBold',
  bold: 'Inter_700Bold',
  semiBold: 'Inter_600SemiBold',
  medium: 'Inter_500Medium',
  regular: 'Inter_400Regular',
} as const;

export interface TypographyToken {
  fontFamily: string;
  fontSize: number;
  lineHeight?: number;
  letterSpacing?: number;
  textTransform?: 'uppercase';
}

export const typography = {
  display: { fontFamily: fontFamily.black, fontSize: 58, lineHeight: 62, letterSpacing: -1.2 },
  hero: { fontFamily: fontFamily.black, fontSize: 48, letterSpacing: -1.0 },
  pageTitle: { fontFamily: fontFamily.bold, fontSize: 24, lineHeight: 28 },
  sheetTitle: { fontFamily: fontFamily.bold, fontSize: 20, lineHeight: 24 },
  cardTitle: { fontFamily: fontFamily.bold, fontSize: 17, lineHeight: 23, letterSpacing: -0.2 },
  sectionLabel: {
    fontFamily: fontFamily.semiBold,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  body: { fontFamily: fontFamily.regular, fontSize: 15, lineHeight: 22 },
  bodyMedium: { fontFamily: fontFamily.medium, fontSize: 15, lineHeight: 22 },
  meta: { fontFamily: fontFamily.medium, fontSize: 12, lineHeight: 16 },
  button: { fontFamily: fontFamily.bold, fontSize: 16, lineHeight: 20, letterSpacing: 0.2 },
  navLabelTab: { fontFamily: fontFamily.bold, fontSize: 11 },
  navLabelHeader: { fontFamily: fontFamily.bold, fontSize: 16, lineHeight: 20 },
  chip: { fontFamily: fontFamily.semiBold, fontSize: 13 },
  pillSmall: { fontFamily: fontFamily.semiBold, fontSize: 11 },
  metric: { fontFamily: fontFamily.bold, fontSize: 30, lineHeight: 36 },
} as const satisfies Record<string, TypographyToken>;
export type TypographyName = keyof typeof typography;

// The text component caps font scaling at 1.3x. On Android the line height is at least 1.21x the font size.
export const MAX_FONT_SCALE = 1.3;
export const ANDROID_MIN_LINE_HEIGHT_RATIO = 1.21;

// 17.3 Spacing, radii, borders, shadows
export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48, xxxl: 64 } as const;
export type SpacingName = keyof typeof spacing;

export const layout = {
  screenPaddingX: 24,
  gridGap: 14,
  cardPadding: 16,
  sectionGapMin: 16,
  sectionGapMax: 24,
  scrollTopPadding: 16,
  tabScreenBottomPaddingMin: 160,
  tabScreenBottomPaddingMax: 200,
} as const;

export const radii = { card: 18, sheet: 24, input: 14, small: 10, pill: 999 } as const;
export type RadiusName = keyof typeof radii;

export const borders = {
  hairlineWidth: 1,
  outlineWidth: 1.5,
  dashedWidth: 1.5,
  selectedTileWidth: 2,
  hairlineColor: colors.hairline,
  outlineColor: colors.ink,
  selectedTileColor: colors.ink,
} as const;

// Shadows apply to floating elements only. Cards never have shadows.
export const shadows = {
  tabBar: {
    shadowColor: '#000000',
    shadowOpacity: 0.1,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  floatingAction: {
    shadowColor: '#000000',
    shadowOpacity: 0.18,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  bottomSheet: {
    shadowColor: '#000000',
    shadowOpacity: 0.15,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: -6 },
    elevation: 16,
  },
} as const satisfies Record<string, ViewStyle>;
export type ShadowName = keyof typeof shadows;

// 17.5 Motion
export const motion = {
  duration: { fast: 200, base: 280, slow: 350 },
  statusTicker: { intervalMs: 1800, outMs: 220, inMs: 260, offsetY: 8 },
  successEnter: { fadeInDownDelayMs: 80 },
} as const;

// 17.4 Components: per-element values the component library reads.
export const pressScale = {
  default: 0.97,
  iconButton: 0.9,
  chip: 0.94,
  filterChip: 0.95,
  row: 0.98,
  tile: 0.98,
  toggle: 0.99,
} as const;

export const pressSpring = { stiffness: 220, damping: 18, mass: 0.7 } as const;

export const components = {
  press: { hitSlop: 8, retentionOffset: 24, disabledOpacity: 0.5 },
  primaryButton: { padding: 16, approxHeight: 52 },
  field: { radius: radii.input, borderWidth: borders.outlineWidth },
  chip: { paddingX: 16, paddingY: 8, borderWidth: borders.outlineWidth },
  filterChips: { height: 38 },
  segmentedControl: { trackPadding: 4 },
  statusChip: { paddingX: 10, paddingY: 3 },
  banner: { radius: radii.card, iconSize: 22 },
  screenHeader: { backButtonSize: 40 },
  iconButton: { size: 44, badgeSize: 18, badgeRingWidth: 2, dotSize: 8 },
  listRow: {
    radius: radii.card,
    padding: 16,
    gap: 16,
    iconSize: 20,
    thumbnailSize: 52,
    countBadgeSize: 22,
    chevronSize: 18,
  },
  panel: { radius: radii.card, padding: 16, gap: 8 },
  mediaSlot: { aspectRatio: 0.8, radius: radii.card, removeButtonSize: 26, plusSize: 28 },
  bottomSheet: { topRadius: radii.sheet, padding: 24, gap: 16 },
  toast: {
    paddingX: 24,
    paddingY: 14,
    dotSize: 8,
    bottomOffset: 90,
    enterRise: 20,
    enterDurationMinMs: 200,
    enterDurationMaxMs: 220,
    autoHideMs: 2200,
  },
  emptyState: { circleSize: 56, iconSize: 26 },
  skeleton: { pulseMs: 900, minOpacity: 0.4, maxOpacity: 1 },
  progress: { spinnerSize: 64, spinnerBorderWidth: 4, spinnerRotationMs: 1000, barHeight: 6 },
  floatingTabBar: { widthFraction: 0.9, bottomOffset: 8, minBottomInset: 10, iconSize: 22, labelSize: 11 },
  icons: { chevron: 18, rowMin: 20, rowMax: 22, largeMin: 26, largeMax: 30 },
  image: { fadeMs: 320, outputAspectRatio: 3 / 4, slotAspectRatio: 0.8 },
} as const;

// Haptics through expo-haptics (implementations in haptics.ts).
export const hapticUsage = {
  light: 'every press',
  selection: 'tile or row select',
  medium: 'long press',
  success: 'success notification: toasts, login, batch created, download finished',
  error: 'error notification: toasts, login, batch created, download failed',
} as const;
export type HapticName = keyof typeof hapticUsage;
