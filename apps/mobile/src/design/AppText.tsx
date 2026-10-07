import { Platform, Text, type TextProps, type TextStyle } from 'react-native';
import {
  ANDROID_MIN_LINE_HEIGHT_RATIO,
  MAX_FONT_SCALE,
  colors,
  typography,
  type TypographyName,
  type TypographyToken,
} from './theme';

export interface AppTextProps extends TextProps {
  variant?: TypographyName;
  color?: string;
}

// Maps a typography token to a text style. On Android the line height is at least 1.21x the font size.
export function resolveTextStyle(token: TypographyToken, os: string = Platform.OS): TextStyle {
  const style: TextStyle = {
    fontFamily: token.fontFamily,
    fontSize: token.fontSize,
  };
  if (token.letterSpacing !== undefined) style.letterSpacing = token.letterSpacing;
  if (token.textTransform !== undefined) style.textTransform = token.textTransform;
  if (os === 'android') {
    style.lineHeight = Math.max(token.lineHeight ?? 0, Math.ceil(token.fontSize * ANDROID_MIN_LINE_HEIGHT_RATIO));
  } else if (token.lineHeight !== undefined) {
    style.lineHeight = token.lineHeight;
  }
  return style;
}

export function AppText({
  variant = 'body',
  color = colors.ink,
  style,
  maxFontSizeMultiplier = MAX_FONT_SCALE,
  ...rest
}: AppTextProps) {
  return (
    <Text
      {...rest}
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      style={[resolveTextStyle(typography[variant]), { color }, style]}
    />
  );
}
